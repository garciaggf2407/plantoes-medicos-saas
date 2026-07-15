import { Body, Controller, Get, NotFoundException, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthService, OidcCallbackError, type RegisterDoctorInput } from "./auth.service";
import { Public } from "./decorators/public.decorator";

@Controller("auth")
@Public()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get("login")
  async login(@Res() res: Response): Promise<void> {
    const authorizationUrl = await this.auth.startLogin(res);
    res.redirect(302, authorizationUrl);
  }

  @Get("callback")
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query("code") code?: string,
    @Query("state") state?: string,
    @Query("error") error?: string,
  ): Promise<void> {
    try {
      await this.auth.handleCallback(req, res, { code, state, error });
      res.redirect(302, this.auth.getPostLoginRedirectUrl());
    } catch (err) {
      if (err instanceof OidcCallbackError) {
        // Falha aqui é esperada sempre que um link de login é reusado
        // (ex.: botão "voltar" do navegador reabrindo a página de
        // dev-login depois de já ter autenticado -- code/state são de
        // uso único). Devolver JSON cru deixava o operador num beco sem
        // saída; redirecionar de volta pro app com o motivo na query
        // deixa a home mostrar "Entrar" de novo em vez de travar.
        const url = new URL(this.auth.getPostLoginRedirectUrl());
        url.searchParams.set("auth_error", err.message);
        res.redirect(302, url.toString());
        return;
      }
      throw err;
    }
  }

  /**
   * Página clicável do FakeOidcProvider (ver renderDevLoginPage). 404
   * em qualquer deploy com provedor OIDC real -- não é uma rota
   * condicionalmente registrada, é uma checagem em toda requisição,
   * para nunca depender de "isso não deveria estar acessível".
   */
  @Get("dev-login")
  async devLogin(
    @Query("redirect_uri") redirectUri: string,
    @Query("state") state: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.auth.isFakeProviderActive()) throw new NotFoundException();
    const html = await this.auth.renderDevLoginPage({ redirectUri, state });
    res.type("html").send(html);
  }

  @Get("dev-login/submit")
  async devLoginSubmit(
    @Query("email") email: string,
    @Query("subject") subject: string | undefined,
    @Query("redirect_uri") redirectUri: string,
    @Query("state") state: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.auth.isFakeProviderActive()) throw new NotFoundException();
    const url = this.auth.buildDevLoginRedirect({ email, subject, redirectUri, state });
    res.redirect(302, url);
  }

  /**
   * Auto-cadastro de médico (BP demo ao vivo) — 404 fora do double
   * local, mesmo padrão de isFakeProviderActive() das rotas dev-login
   * acima. Numa implantação com OIDC real, esta rota não existe; o
   * primeiro login já auto-provisiona DOCTOR (ver
   * resolveOrProvisionUser), e o perfil é completado depois via
   * PUT /doctors/me/profile.
   */
  @Post("dev-register/doctor")
  async registerDoctor(@Res() res: Response, @Body() body: RegisterDoctorInput): Promise<void> {
    if (!this.auth.isFakeProviderActive()) throw new NotFoundException();
    const account = await this.auth.registerDoctor(res, body);
    res.status(201).json(account);
  }

  @Post("logout")
  async logout(@Res() res: Response): Promise<void> {
    const providerLogoutUrl = await this.auth.logout(res, this.auth.getPostLoginRedirectUrl());
    res.status(200).json({ providerLogoutUrl: providerLogoutUrl ?? null });
  }
}
