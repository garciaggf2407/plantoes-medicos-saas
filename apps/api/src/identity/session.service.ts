import { Injectable } from "@nestjs/common";
import type { Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadOidcConfig, type OidcConfig } from "./oidc-config";

export const SESSION_COOKIE_NAME = "plantoes_session";

export interface SessionPayload {
  subject: string;
  email: string;
  exp: number;
}

/**
 * Sessão via cookie assinado (HMAC-SHA256), nunca via token
 * armazenado no servidor em memória compartilhada. Cookie sempre
 * HttpOnly + SameSite=Lax; Secure é obrigatório exceto quando
 * COOKIE_SECURE=false (apenas para desenvolvimento local sobre HTTP).
 */
@Injectable()
export class SessionService {
  private readonly config: OidcConfig;

  constructor() {
    this.config = loadOidcConfig();
  }

  private sign(value: string): string {
    return createHmac("sha256", this.config.sessionSecret).update(value).digest("base64url");
  }

  issue(res: Response, payload: SessionPayload): void {
    const raw = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = this.sign(raw);
    res.cookie(SESSION_COOKIE_NAME, `${raw}.${signature}`, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: "lax",
      maxAge: this.config.sessionTtlSeconds * 1000,
      path: "/",
    });
  }

  clear(res: Response): void {
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: "lax",
      path: "/",
    });
  }

  verify(cookieValue: string | undefined): SessionPayload | null {
    if (!cookieValue) {
      return null;
    }
    const [raw, signature] = cookieValue.split(".");
    if (!raw || !signature) {
      return null;
    }

    const expectedSignature = this.sign(raw);
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as SessionPayload;
    if (payload.exp * 1000 < Date.now()) {
      return null;
    }
    return payload;
  }
}
