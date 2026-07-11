import type { BrowserContext, APIRequestContext } from "@playwright/test";

export const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";

/**
 * Reproduz o fluxo OIDC Authorization Code + PKCE contra o
 * FakeOidcProvider (ativo quando OIDC_ISSUER_URL está vazio -- ver
 * apps/api/src/identity/auth.module.ts) usando apenas HTTP puro,
 * exatamente como apps/api/test/identity/auth.e2e-spec.ts faz via
 * supertest. Não existe UI de login para clicar (o double não usa um
 * provedor real) -- este é o caminho real e correto para autenticar
 * um ator neste app quando não há credenciais de provedor externo.
 *
 * FakeOidcProvider.encodeCode: o "code" já carrega subject:email em
 * base64url (ver fake-oidc.provider.ts) -- não há chamada de rede a
 * um provedor de verdade.
 */
function encodeFakeCode(subject: string, email: string): string {
  return Buffer.from(`${subject}:${email}`, "utf8").toString("base64url");
}

function extractCookie(setCookieHeaders: string[], name: string): string {
  const found = setCookieHeaders.find((c) => c.startsWith(`${name}=`));
  if (!found) {
    throw new Error(`Cookie ${name} não encontrado em Set-Cookie: ${setCookieHeaders.join(" | ")}`);
  }
  return found.split(";")[0]!.slice(name.length + 1);
}

/**
 * Faz o handshake completo de login e retorna só o VALOR do cookie
 * plantoes_session (raw.assinatura) -- sem injetar em lugar nenhum.
 * Quem chama decide onde aplicar: no BrowserContext (ator navegando
 * de verdade) via addSessionCookie(), ou direto num header Cookie de
 * chamada de API (ator secundário do cenário, cuja ação não precisa
 * passar pelo navegador).
 */
export async function getSessionCookieValue(request: APIRequestContext, subject: string, email: string): Promise<string> {
  const loginRes = await request.get(`${API_URL}/auth/login`, { maxRedirects: 0 });
  const loginSetCookies = loginRes.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
  const pendingCookieValue = extractCookie(loginSetCookies, "plantoes_auth_pending");
  const location = loginRes.headers()["location"];
  if (!location) throw new Error("GET /auth/login não retornou Location");
  const state = new URL(location).searchParams.get("state");
  if (!state) throw new Error("state ausente na URL de autorização do fake OIDC");

  const code = encodeFakeCode(subject, email);
  const callbackRes = await request.get(`${API_URL}/auth/callback`, {
    params: { code, state },
    headers: { Cookie: `plantoes_auth_pending=${pendingCookieValue}` },
    maxRedirects: 0,
  });
  const callbackSetCookies = callbackRes.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
  return extractCookie(callbackSetCookies, "plantoes_session");
}

/** Injeta um valor de cookie de sessão já obtido no BrowserContext, para páginas abertas nele chegarem autenticadas. */
export async function addSessionCookie(context: BrowserContext, cookieValue: string): Promise<void> {
  const apiUrl = new URL(API_URL);
  await context.addCookies([
    {
      name: "plantoes_session",
      value: cookieValue,
      // Cookies não são específicos de porta -- domain "localhost"
      // vale tanto para :3000 (web) quanto :3001 (api). secure:false
      // porque o webServer da API roda com COOKIE_SECURE=false neste
      // E2E (mesma convenção de dev local sobre HTTP puro) --
      // manter os dois em sincronia evita depender do tratamento
      // específico do Chromium para "localhost" como contexto seguro.
      domain: apiUrl.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

/** Combinação conveniente para o caso comum: um único ator navegando de verdade pelo navegador. */
export async function loginAs(context: BrowserContext, request: APIRequestContext, subject: string, email: string): Promise<void> {
  const cookieValue = await getSessionCookieValue(request, subject, email);
  await addSessionCookie(context, cookieValue);
}

/** Header Cookie pronto para uma chamada de API autenticada de um ator que não precisa navegar pelo browser. */
export function cookieHeader(cookieValue: string): { Cookie: string } {
  return { Cookie: `plantoes_session=${cookieValue}` };
}
