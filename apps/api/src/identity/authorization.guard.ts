import { Injectable, CanActivate, type ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { UserRole } from "@prisma/client";
import { IS_PUBLIC_KEY } from "./decorators/public.decorator";
import { ROLES_KEY } from "./decorators/roles.decorator";
import type { AuthenticatedUser } from "./guards/authentication.guard";

/**
 * Guard de autorização por papel (doctor, hospital_admin, superadmin).
 * Roda depois de AuthenticationGuard (que já populou req.user).
 *
 * Default deny: qualquer rota que não seja @Public() e não declare
 * @Roles(...) é negada com 403 — autorização nunca é "permitir por
 * esquecimento". Autorização é sempre decidida aqui no servidor,
 * nunca a partir de um header/campo enviado pelo cliente.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      throw new ForbiddenException(
        "Rota autenticada sem @Roles() declarado — negada por padrão (default deny)",
      );
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException("Papel do usuário não autorizado para esta rota");
    }

    return true;
  }
}
