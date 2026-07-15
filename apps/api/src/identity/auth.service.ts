import { BadRequestException, Injectable, Inject } from "@nestjs/common";
import type { Request, Response } from "express";
import { createHmac, timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { UserRole } from "@prisma/client";
import { OIDC_PROVIDER } from "./identity.tokens";
import type { OidcProvider } from "./interfaces/oidc-provider.interface";
import type { AuthenticatedUser } from "./guards/authentication.guard";
import { FakeOidcProvider } from "./providers/fake-oidc.provider";
import { SessionService } from "./session.service";
import { loadOidcConfig, type OidcConfig } from "./oidc-config";
import { PrismaService } from "../prisma/prisma.service";
import { CredentialsService, type DoctorProfileInput } from "../credentials/credentials.service";
import { telemetry, withSpan } from "../observability/telemetry";
import { logEvent } from "../observability/structured-logger";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RegisterDoctorInput extends DoctorProfileInput {
  email: string;
}

export interface DevAccountSummary {
  email: string;
  role: UserRole;
  organizationName: string | null;
}

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
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
  ) {
    this.config = loadOidcConfig();
  }

  /**
   * Resolve o usuário local para um subject/email vindos do provedor
   * OIDC autenticado, em três passos:
   *  1. Login recorrente: já existe User com este oidcSubject.
   *  2. Convite pendente (T-2.1.1): existe User com este email e
   *     oidcSubject placeholder "pending:*" (hospital_admin
   *     convidado por um superadmin) — a conta é reivindicada
   *     trocando o subject placeholder pelo subject real.
   *  3. Primeiro acesso sem convite: provisiona um User novo com
   *     papel DOCTOR (auto-cadastro — hospital_admin/superadmin
   *     nunca são criados implicitamente, apenas por convite).
   */
  private async resolveOrProvisionUser(subject: string, email: string): Promise<UserRole> {
    const existingBySubject = await this.prisma.user.findUnique({ where: { oidcSubject: subject } });
    if (existingBySubject) {
      return existingBySubject.role;
    }

    const existingByEmail = await this.prisma.user.findUnique({ where: { email } });
    if (existingByEmail && existingByEmail.oidcSubject.startsWith("pending:")) {
      const claimed = await this.prisma.user.update({
        where: { id: existingByEmail.id },
        data: { oidcSubject: subject },
      });
      return claimed.role;
    }
    if (existingByEmail) {
      // Email já pertence a uma conta com subject definitivo diferente
      // (ex.: trocou de provedor) — não reivindicamos silenciosamente.
      throw new OidcCallbackError("email_already_claimed");
    }

    const created = await this.prisma.user.create({
      data: { oidcSubject: subject, email, role: UserRole.DOCTOR },
    });
    return created.role;
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

    await withSpan("auth.login", {}, async () => {
      const tokens = await this.provider.exchangeCodeForTokens({
        code: query.code!,
        redirectUri: this.config.redirectUri,
        codeVerifier: pending.codeVerifier,
        expectedNonce: pending.nonce,
      });

      const role = await this.resolveOrProvisionUser(tokens.subject, tokens.email);

      this.sessions.issue(res, {
        subject: tokens.subject,
        email: tokens.email,
        exp: Math.floor(Date.now() / 1000) + this.config.sessionTtlSeconds,
      });

      telemetry.loginCounter.add(1, { role });
      logEvent("auth.login", { role });
    });
  }

  /**
   * Para onde o navegador vai depois de um login bem-sucedido. É a app
   * web (Next.js), não este próprio serviço -- callback() usava "/"
   * literal antes, o que aterrissava o usuário na raiz da API (nunca
   * exercitado por um navegador real: os testes automatizados só
   * inspecionam o header Location, nunca seguem o redirect de verdade).
   */
  getPostLoginRedirectUrl(): string {
    return this.config.webOrigin;
  }

  async logout(res: Response, postLogoutRedirectUri: string): Promise<string | null> {
    this.sessions.clear(res);
    return this.provider.getEndSessionUrl(postLogoutRedirectUri);
  }

  /**
   * Só true quando não há provedor real configurado (ver auth.module.ts).
   * Usado para gatear /auth/dev-login: essa rota não pode fazer nada em
   * um deploy com OIDC real, mesmo que alguém a chame diretamente.
   */
  isFakeProviderActive(): boolean {
    return this.provider instanceof FakeOidcProvider;
  }

  /**
   * Cadastro self-serve de médico (double local): cria a conta e já
   * grava o perfil (CRM/especialidades/cidade) num passo só, em vez de
   * deixar o médico cair pós-login num perfil vazio (gap real
   * encontrado e corrigido manualmente numa sessão anterior). Reusa
   * CredentialsService.upsertOwnProfile para não duplicar validação —
   * o "actor" é montado na mão porque o usuário acabou de ser criado
   * nesta mesma chamada, não existe request autenticada ainda.
   */
  async registerDoctor(res: Response, input: RegisterDoctorInput): Promise<DevAccountSummary> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      throw new BadRequestException("email inválido");
    }
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new BadRequestException("já_existe_conta_com_este_email");
    }

    const subject = `dev-doctor-${randomUUID()}`;
    const user = await this.prisma.user.create({ data: { oidcSubject: subject, email, role: UserRole.DOCTOR } });

    const actor: AuthenticatedUser = { id: user.id, email: user.email, role: user.role, organizationId: null };
    await this.credentials.upsertOwnProfile(actor, {
      crmNumber: input.crmNumber,
      specialties: input.specialties,
      contactPhone: input.contactPhone,
      city: input.city,
    });

    this.sessions.issue(res, {
      subject,
      email,
      exp: Math.floor(Date.now() / 1000) + this.config.sessionTtlSeconds,
    });
    telemetry.loginCounter.add(1, { role: "DOCTOR" });
    logEvent("auth.register_doctor", { role: "DOCTOR" });

    return { email, role: UserRole.DOCTOR, organizationName: null };
  }

  /**
   * Página de login clicável do double local. Sem isso, /auth/login
   * redireciona para uma URL que não resolve em um navegador real (ver
   * fake-oidc.provider.ts) -- só útil para o handshake HTTP puro dos
   * testes automatizados. Lista contas já existentes (uma por papel, se
   * houver -- inclui SUPERADMIN, que nunca aparecia aqui antes: sem
   * isso, testar esse papel exigia montar a URL de /auth/dev-login/submit
   * à mão) para reentrar nelas, e um formulário para provisionar um
   * médico novo (única auto-provisão que a regra de negócio permite;
   * ver resolveOrProvisionUser). HOSPITAL_ADMIN/SUPERADMIN continuam sem
   * auto-provisão de propósito -- só aparecem aqui se já existirem.
   */
  async renderDevLoginPage(params: { redirectUri: string; state: string }): Promise<string> {
    const [sampleDoctor, sampleAdmin, sampleSuperadmin] = await Promise.all([
      this.prisma.user.findFirst({ where: { role: UserRole.DOCTOR }, orderBy: { createdAt: "asc" } }),
      this.prisma.user.findFirst({ where: { role: UserRole.HOSPITAL_ADMIN }, orderBy: { createdAt: "asc" } }),
      this.prisma.user.findFirst({ where: { role: UserRole.SUPERADMIN }, orderBy: { createdAt: "asc" } }),
    ]);

    const submitUrl = (subject: string, email: string): string => {
      const url = new URL("/auth/dev-login/submit", params.redirectUri);
      url.searchParams.set("redirect_uri", params.redirectUri);
      url.searchParams.set("state", params.state);
      url.searchParams.set("subject", subject);
      url.searchParams.set("email", email);
      return url.toString();
    };

    const existingAccountLink = (label: string, user: { oidcSubject: string; email: string } | null): string => {
      if (!user) return "";
      return `<li><a class="account-link" href="${submitUrl(user.oidcSubject, user.email)}"><span class="role-badge">${label}</span><span class="account-email">${user.email}</span></a></li>`;
    };

    const accountLinks = [
      existingAccountLink("Médico", sampleDoctor),
      existingAccountLink("Admin hospitalar", sampleAdmin),
      existingAccountLink("Superadmin", sampleSuperadmin),
    ].join("");

    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login local (dev) — Plantões Médicos</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      width: 100%;
      max-width: 28rem;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 0.75rem;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
      padding: 2rem;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.25rem; }
    .badge {
      display: inline-block;
      font-size: 0.75rem;
      font-weight: 500;
      color: #b45309;
      background: #fef3c7;
      border-radius: 9999px;
      padding: 0.125rem 0.625rem;
      margin-bottom: 1.25rem;
    }
    h2 { font-size: 0.875rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.03em; margin: 1.5rem 0 0.75rem; }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
    .account-link {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 0.625rem 0.875rem;
      border: 1px solid #e2e8f0;
      border-radius: 0.5rem;
      text-decoration: none;
      color: #0f172a;
      transition: background-color 0.1s ease;
    }
    .account-link:hover { background: #f1f5f9; }
    .role-badge {
      font-size: 0.6875rem;
      font-weight: 600;
      color: #1d4ed8;
      background: #dbeafe;
      border-radius: 0.375rem;
      padding: 0.125rem 0.5rem;
      white-space: nowrap;
    }
    .account-email { font-size: 0.875rem; color: #334155; }
    .empty-state { font-size: 0.8125rem; color: #94a3b8; padding: 0.5rem 0; }
    form { display: flex; flex-direction: column; gap: 0.625rem; }
    label { font-size: 0.8125rem; color: #475569; }
    input[type="email"] {
      width: 100%;
      margin-top: 0.25rem;
      padding: 0.5rem 0.75rem;
      border: 1px solid #cbd5e1;
      border-radius: 0.5rem;
      font-size: 0.875rem;
    }
    input[type="email"]:focus { outline: 2px solid #2563eb; outline-offset: 1px; }
    button {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 0.5rem;
      padding: 0.625rem 1rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
    p.hint { font-size: 0.75rem; color: #94a3b8; margin: 1.5rem 0 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Login de desenvolvimento</h1>
    <span class="badge">FakeOidcProvider — sem OIDC real configurado</span>

    <h2>Contas existentes</h2>
    <ul>
      ${accountLinks || '<li class="empty-state">Nenhuma conta ainda. Crie um médico abaixo, ou um admin/superadmin diretamente no banco.</li>'}
    </ul>

    <h2>Entrar como médico novo</h2>
    <form action="/auth/dev-login/submit" method="get">
      <input type="hidden" name="redirect_uri" value="${params.redirectUri}">
      <input type="hidden" name="state" value="${params.state}">
      <label>E-mail
        <input type="email" name="email" required placeholder="seuemail@example.com">
      </label>
      <button type="submit">Entrar</button>
    </form>

    <p class="hint">Esta página nunca existe quando <code>OIDC_ISSUER_URL</code> está definida.</p>
  </div>
</body>
</html>`;
  }

  /**
   * Gera o "code" do double e redireciona para /auth/callback, fechando
   * o mesmo fluxo que o handshake HTTP dos testes automatizados usa --
   * a diferença é só de onde o code vem (clique humano vs. gerado por
   * um script). Sem subject explícito (form de médico novo), gera um
   * subject aleatório -- garante que nunca colide com email já
   * reivindicado por outro subject (ver resolveOrProvisionUser).
   */
  buildDevLoginRedirect(params: { email: string; subject?: string; redirectUri: string; state: string }): string {
    const subject = params.subject && params.subject.length > 0 ? params.subject : `dev-${randomBytes(8).toString("hex")}`;
    const code = FakeOidcProvider.encodeCode(subject, params.email);
    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    url.searchParams.set("state", params.state);
    return url.toString();
  }
}
