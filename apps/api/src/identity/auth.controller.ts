import { Controller, Get, NotFoundException, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthService, OidcCallbackError } from "./auth.service";
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
        res.status(400).json({ error: "authentication_failed", reason: err.message });
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

  @Post("logout")
  async logout(@Res() res: Response): Promise<void> {
    const providerLogoutUrl = await this.auth.logout(res, this.auth.getPostLoginRedirectUrl());
    res.status(200).json({ providerLogoutUrl: providerLogoutUrl ?? null });
  }
}
