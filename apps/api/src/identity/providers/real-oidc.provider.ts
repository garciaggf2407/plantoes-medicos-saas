import { randomBytes, createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type {
  OidcAuthorizationRequest,
  OidcProvider,
  OidcTokenResult,
} from "../interfaces/oidc-provider.interface";
import type { OidcConfig } from "../oidc-config";

interface OidcDiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
  jwks_uri: string;
  issuer: string;
}

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64url");
}

/**
 * Cliente OIDC real (Authorization Code + PKCE) contra um provedor
 * gerenciado (Auth0/Clerk/etc.), descoberto via
 * {issuer}/.well-known/openid-configuration. Nenhuma senha é
 * manipulada por esta aplicação em nenhum momento do fluxo.
 */
export class RealOidcProvider implements OidcProvider {
  private discoveryPromise: Promise<OidcDiscoveryDocument> | null = null;
  private jwksPromise: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly config: OidcConfig) {}

  private async discover(): Promise<OidcDiscoveryDocument> {
    if (!this.config.issuerUrl) {
      throw new Error("OIDC_ISSUER_URL não configurado");
    }
    if (!this.discoveryPromise) {
      const issuer = this.config.issuerUrl.replace(/\/$/, "");
      this.discoveryPromise = fetch(`${issuer}/.well-known/openid-configuration`)
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Falha na descoberta OIDC: HTTP ${res.status}`);
          }
          return res.json() as Promise<OidcDiscoveryDocument>;
        });
    }
    return this.discoveryPromise;
  }

  private async jwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    const doc = await this.discover();
    if (!this.jwksPromise) {
      this.jwksPromise = createRemoteJWKSet(new URL(doc.jwks_uri));
    }
    return this.jwksPromise;
  }

  async buildAuthorizationRequest(redirectUri: string): Promise<OidcAuthorizationRequest> {
    const doc = await this.discover();
    const state = randomBytes(16).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    const codeVerifier = base64UrlEncode(randomBytes(32));
    const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());

    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    return { url: url.toString(), state, nonce, codeVerifier };
  }

  async exchangeCodeForTokens(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    expectedNonce: string;
  }): Promise<OidcTokenResult> {
    const doc = await this.discover();

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: params.codeVerifier,
    });

    const response = await fetch(doc.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`Falha na troca de código por token: HTTP ${response.status}`);
    }

    const tokenResponse = (await response.json()) as { id_token?: string };
    if (!tokenResponse.id_token) {
      throw new Error("Resposta do provedor não contém id_token");
    }

    const { payload } = await jwtVerify(tokenResponse.id_token, await this.jwks(), {
      issuer: doc.issuer,
      audience: this.config.clientId,
    });

    if (payload.nonce !== params.expectedNonce) {
      throw new Error("Nonce do id_token não confere — possível replay");
    }
    if (!payload.sub || typeof payload.email !== "string") {
      throw new Error("id_token sem sub/email");
    }

    return {
      subject: payload.sub,
      email: payload.email,
      expiresAt: payload.exp ?? Math.floor(Date.now() / 1000) + 3600,
    };
  }

  async getEndSessionUrl(postLogoutRedirectUri: string): Promise<string | null> {
    const doc = await this.discover();
    if (!doc.end_session_endpoint) {
      return null;
    }
    const url = new URL(doc.end_session_endpoint);
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
    url.searchParams.set("client_id", this.config.clientId);
    return url.toString();
  }
}
