import { randomBytes } from "node:crypto";
import { SignJWT, generateKeyPair, type KeyLike } from "jose";
import type {
  OidcAuthorizationRequest,
  OidcProvider,
  OidcTokenResult,
} from "../interfaces/oidc-provider.interface";

/**
 * Double local do provedor OIDC. Usado quando OIDC_ISSUER_URL não está
 * configurado (sem credenciais de provedor real disponíveis). Emite
 * tokens localmente assinados — nunca deve ser usado com
 * COOKIE_SECURE=true em ambiente que não seja local/CI.
 */
export class FakeOidcProvider implements OidcProvider {
  private signingKeyPromise: Promise<{ privateKey: KeyLike }> | null = null;

  private async getSigningKey(): Promise<{ privateKey: KeyLike }> {
    if (!this.signingKeyPromise) {
      this.signingKeyPromise = generateKeyPair("RS256").then(({ privateKey }) => ({
        privateKey,
      }));
    }
    return this.signingKeyPromise;
  }

  async buildAuthorizationRequest(redirectUri: string): Promise<OidcAuthorizationRequest> {
    const state = randomBytes(16).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    const codeVerifier = randomBytes(32).toString("hex");

    const url = new URL("http://fake-oidc.local/authorize");
    url.searchParams.set("client_id", "local-dev-client");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);

    return { url: url.toString(), state, nonce, codeVerifier };
  }

  async exchangeCodeForTokens(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    expectedNonce: string;
  }): Promise<OidcTokenResult> {
    // O "code" no double já carrega subject:email para simular o
    // retorno de um provedor real, sem precisar de rede externa.
    const [subject, email] = Buffer.from(params.code, "base64url").toString("utf8").split(":");
    if (!subject || !email) {
      throw new Error("invalid_grant: código de autorização inválido");
    }

    const { privateKey } = await this.getSigningKey();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    await new SignJWT({ email, nonce: params.expectedNonce })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .setIssuer("http://fake-oidc.local/")
      .setAudience("local-dev-client")
      .sign(privateKey);

    return { subject, email, expiresAt };
  }

  async getEndSessionUrl(postLogoutRedirectUri: string): Promise<string | null> {
    const url = new URL("http://fake-oidc.local/logout");
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
    return url.toString();
  }

  /** Helper apenas para testes de integração construírem um "code" válido. */
  static encodeCode(subject: string, email: string): string {
    return Buffer.from(`${subject}:${email}`, "utf8").toString("base64url");
  }
}
