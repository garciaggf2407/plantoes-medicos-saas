import { Body, Controller, Post } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import {
  ProvisionOrganizationUseCase,
  type ProvisionOrganizationInput,
  type ProvisionOrganizationResult,
} from "./provision-organization.use-case";

@Controller("organizations")
export class OrganizationsController {
  constructor(private readonly provisionOrganization: ProvisionOrganizationUseCase) {}

  @Post()
  @Roles(UserRole.SUPERADMIN)
  async provision(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: ProvisionOrganizationInput,
  ): Promise<ProvisionOrganizationResult> {
    return this.provisionOrganization.execute(actor, body);
  }
}
