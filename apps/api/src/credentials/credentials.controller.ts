import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import { CredentialsService, type DoctorProfileInput, type SubmitCredentialInput } from "./credentials.service";

@Controller()
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Put("doctors/me/profile")
  @Roles(UserRole.DOCTOR)
  async upsertOwnProfile(@CurrentUser() actor: AuthenticatedUser, @Body() body: DoctorProfileInput) {
    return this.credentials.upsertOwnProfile(actor, body);
  }

  @Get("doctors/me/profile")
  @Roles(UserRole.DOCTOR)
  async getOwnProfile(@CurrentUser() actor: AuthenticatedUser) {
    return this.credentials.getOwnProfile(actor);
  }

  @Post("doctors/me/credentials")
  @Roles(UserRole.DOCTOR)
  async submitCredential(@CurrentUser() actor: AuthenticatedUser, @Body() body: SubmitCredentialInput) {
    return this.credentials.submitCredential(actor, body);
  }

  @Get("credentials/:id")
  @Roles(UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN)
  async getCredential(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("id") id: string,
    @Query("organizationId") organizationId: string,
  ) {
    return this.credentials.getCredential(actor, id, organizationId);
  }
}
