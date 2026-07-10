export interface OidcConfig {
  issuerUrl: string | null;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  cookieSecure: boolean;
}

/**
 * Toda credencial vem exclusivamente de variáveis de ambiente — nunca
 * de valor literal no código-fonte. Quando OIDC_ISSUER_URL não está
 * definido (sem credenciais de provedor real ainda), o módulo usa o
 * FakeOidcProvider automaticamente.
 */
export function loadOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig {
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 16) {
    throw new Error(
      "SESSION_SECRET ausente ou fraco: defina uma variável de ambiente SESSION_SECRET com pelo menos 16 caracteres.",
    );
  }

  return {
    issuerUrl: env.OIDC_ISSUER_URL?.trim() || null,
    clientId: env.OIDC_CLIENT_ID ?? "local-dev-client",
    clientSecret: env.OIDC_CLIENT_SECRET ?? "",
    redirectUri: env.OIDC_REDIRECT_URI ?? "http://localhost:3001/auth/callback",
    sessionSecret,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS ? Number(env.SESSION_TTL_SECONDS) : 3600,
    cookieSecure: env.COOKIE_SECURE !== "false",
  };
}
