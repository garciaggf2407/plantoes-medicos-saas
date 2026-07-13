import { Body, Controller, Get, Patch, Post } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { OrganizationProfileDto } from "@plantoes/shared";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import {
  ProvisionOrganizationUseCase,
  type ProvisionOrganizationInput,
  type ProvisionOrganizationResult,
} from "./provision-organization.use-case";
import { GetOrganizationProfileUseCase } from "./get-organization-profile.use-case";
import {
  UpdateOrganizationProfileUseCase,
  type UpdateOrganizationProfileInput,
} from "./update-organization-profile.use-case";

@Controller("organizations")
export class OrganizationsController {
  constructor(
    private readonly provisionOrganization: ProvisionOrganizationUseCase,
    private readonly getOrganizationProfile: GetOrganizationProfileUseCase,
    private readonly updateOrganizationProfile: UpdateOrganizationProfileUseCase,
  ) {}

  @Post()
  @Roles(UserRole.SUPERADMIN)
  async provision(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: ProvisionOrganizationInput,
  ): Promise<ProvisionOrganizationResult> {
    return this.provisionOrganization.execute(actor, body);
  }

  /** Perfil do PRÓPRIO hospital do hospital_admin autenticado (BP-2026-07-12-001). */
  @Get("me")
  @Roles(UserRole.HOSPITAL_ADMIN)
  async getMe(@CurrentUser() actor: AuthenticatedUser): Promise<OrganizationProfileDto> {
    return this.getOrganizationProfile.execute(actor);
  }

  /** Edição do perfil do PRÓPRIO hospital do hospital_admin autenticado (BP-2026-07-12-001). */
  @Patch("me")
  @Roles(UserRole.HOSPITAL_ADMIN)
  async updateMe(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: UpdateOrganizationProfileInput,
  ): Promise<OrganizationProfileDto> {
    return this.updateOrganizationProfile.execute(actor, body);
  }
}
