export interface OidcAuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcTokenResult {
  subject: string;
  email: string;
  expiresAt: number;
}

/**
 * Abstração sobre o provedor OIDC. A implementação real (RealOidcProvider)
 * fala com um provedor gerenciado (Auth0/Clerk/etc.) via descoberta
 * OIDC padrão. A implementação double (FakeOidcProvider) é usada em
 * desenvolvimento/teste enquanto não há credenciais de provedor real
 * (ver ACTIVATION.md — "usar adapters/doubles até CP-5").
 */
export interface OidcProvider {
  buildAuthorizationRequest(redirectUri: string): Promise<OidcAuthorizationRequest>;

  exchangeCodeForTokens(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    expectedNonce: string;
  }): Promise<OidcTokenResult>;

  /** URL de logout do provedor (end_session_endpoint), se houver. */
  getEndSessionUrl(postLogoutRedirectUri: string): Promise<string | null>;
}
