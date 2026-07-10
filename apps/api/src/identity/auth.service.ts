import { Injectable, Inject } from "@nestjs/common";
import type { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { OIDC_PROVIDER } from "./identity.tokens";
import type { OidcProvider } from "./interfaces/oidc-provider.interface";
import { SessionService } from "./session.service";
import { loadOidcConfig, type OidcConfig } from "./oidc-config";

const PENDING_AUTH_COOKIE = "plantoes_auth_pending";

interface PendingAuth {
  state: string;
  nonce: string;
  codeVerifier: string;
  exp: number;
}

export class OidcCallbackError extends Error {}

@Injectable()
export class AuthService {
  private readonly config: OidcConfig;

  constructor(
    @Inject(OIDC_PROVIDER) private readonly provider: OidcProvider,
    private readonly sessions: SessionService,
  ) {
    this.config = loadOidcConfig();
  }

  private sign(value: string): string {
    return createHmac("sha256", this.config.sessionSecret).update(value).digest("base64url");
  }

  async startLogin(res: Response): Promise<string> {
    const request = await this.provider.buildAuthorizationRequest(this.config.redirectUri);

    const pending: PendingAuth = {
      state: request.state,
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const raw = Buffer.from(JSON.stringify(pending), "utf8").toString("base64url");
    const signature = this.sign(raw);
    res.cookie(PENDING_AUTH_COOKIE, `${raw}.${signature}`, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
      path: "/auth",
    });

    return request.url;
  }

  private readPendingAuth(req: Request): PendingAuth {
    const cookieValue = (req.cookies as Record<string, string> | undefined)?.[PENDING_AUTH_COOKIE];
    const [raw, signature] = (cookieValue ?? "").split(".");
    if (!raw || !signature) {
      throw new OidcCallbackError("missing_pending_auth");
    }

    const expected = this.sign(raw);
    if (
      Buffer.from(signature).length !== Buffer.from(expected).length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      throw new OidcCallbackError("invalid_pending_auth_signature");
    }

    const pending = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as PendingAuth;
    if (pending.exp * 1000 < Date.now()) {
      throw new OidcCallbackError("pending_auth_expired");
    }
    return pending;
  }

  async handleCallback(
    req: Request,
    res: Response,
    query: { code?: string; state?: string; error?: string },
  ): Promise<void> {
    res.clearCookie(PENDING_AUTH_COOKIE, { path: "/auth" });

    if (query.error) {
      throw new OidcCallbackError(`provider_error:${query.error}`);
    }
    if (!query.code || !query.state) {
      throw new OidcCallbackError("missing_code_or_state");
    }

    const pending = this.readPendingAuth(req);
    if (pending.state !== query.state) {
      throw new OidcCallbackError("state_mismatch");
    }

    const tokens = await this.provider.exchangeCodeForTokens({
      code: query.code,
      redirectUri: this.config.redirectUri,
      codeVerifier: pending.codeVerifier,
      expectedNonce: pending.nonce,
    });

    this.sessions.issue(res, {
      subject: tokens.subject,
      email: tokens.email,
      exp: Math.floor(Date.now() / 1000) + this.config.sessionTtlSeconds,
    });
  }

  async logout(res: Response, postLogoutRedirectUri: string): Promise<string | null> {
    this.sessions.clear(res);
    return this.provider.getEndSessionUrl(postLogoutRedirectUri);
  }
}
