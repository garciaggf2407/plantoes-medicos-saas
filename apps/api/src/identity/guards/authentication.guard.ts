import { Injectable, CanActivate, type ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { UserRole } from "@prisma/client";
import { SessionService, SESSION_COOKIE_NAME } from "../session.service";
import { PrismaService } from "../../prisma/prisma.service";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  organizationId: string | null;
}

/**
 * Resolve a sessão (cookie assinado) para um usuário autenticado e
 * anexa em req.user. Rotas @Public() (ex.: /auth/login) pulam esta
 * verificação. Nunca confia em nenhum dado vindo do cliente além do
 * próprio cookie assinado pelo servidor.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const cookieValue = (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE_NAME];
    const payload = this.sessions.verify(cookieValue);
    if (!payload) {
      throw new UnauthorizedException("Sessão ausente ou inválida");
    }

    const user = await this.prisma.user.findUnique({ where: { oidcSubject: payload.subject } });
    if (!user) {
      throw new UnauthorizedException("Sessão não corresponde a um usuário conhecido");
    }

    request.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
    };
    return true;
  }
}
