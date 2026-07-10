import { SetMetadata } from "@nestjs/common";
import type { UserRole } from "@prisma/client";

export const ROLES_KEY = "roles";

/**
 * Papéis autorizados a acessar a rota. Toda rota autenticada que não
 * for @Public() e não declarar @Roles(...) é negada por padrão
 * (default deny) — ver AuthorizationGuard.
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
