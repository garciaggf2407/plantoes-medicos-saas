import { Controller, Get, Post, Query, Req, Res } from "@nestjs/common";
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
      res.redirect(302, "/");
    } catch (err) {
      if (err instanceof OidcCallbackError) {
        res.status(400).json({ error: "authentication_failed", reason: err.message });
        return;
      }
      throw err;
    }
  }

  @Post("logout")
  async logout(@Res() res: Response): Promise<void> {
    const providerLogoutUrl = await this.auth.logout(res, "/");
    res.status(200).json({ providerLogoutUrl: providerLogoutUrl ?? null });
  }
}
