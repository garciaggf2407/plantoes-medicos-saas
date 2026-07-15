import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { CityDto, OrganizationProfileDto } from "@plantoes/shared";
import { Roles } from "../identity/decorators/roles.decorator";
import { CurrentUser } from "../identity/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/guards/authentication.guard";
import {
  ProvisionOrganizationUseCase,
  type ProvisionOrganizationInput,
  type ProvisionOrganizationResult,
} from "./provision-organization.use-case";
import {
  InviteHospitalAdminUseCase,
  type InviteHospitalAdminInput,
  type InviteHospitalAdminResult,
} from "./invite-hospital-admin.use-case";
import { GetOrganizationProfileUseCase } from "./get-organization-profile.use-case";
import {
  UpdateOrganizationProfileUseCase,
  type UpdateOrganizationProfileInput,
} from "./update-organization-profile.use-case";
import { ListOrganizationsUseCase } from "./list-organizations.use-case";
import { GetOrganizationDetailUseCase } from "./get-organization-detail.use-case";
import { ListCitiesUseCase } from "./list-cities.use-case";

// Sem prefixo de resource no @Controller() -- "organizations" e "cities"
// são recursos irmãos (mesmo padrão de CredentialsController, que também
// declara caminhos completos por rota em vez de um prefixo único), já
// que /cities não é um sub-recurso de um hospital específico (E-3,
// BP-2026-07-13-001).
@Controller()
export class OrganizationsController {
  constructor(
    private readonly provisionOrganization: ProvisionOrganizationUseCase,
    private readonly inviteHospitalAdmin: InviteHospitalAdminUseCase,
    private readonly getOrganizationProfile: GetOrganizationProfileUseCase,
    private readonly updateOrganizationProfile: UpdateOrganizationProfileUseCase,
    private readonly listOrganizations: ListOrganizationsUseCase,
    private readonly getOrganizationDetail: GetOrganizationDetailUseCase,
    private readonly listCitiesUseCase: ListCitiesUseCase,
  ) {}

  @Post("organizations")
  @Roles(UserRole.SUPERADMIN)
  async provision(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: ProvisionOrganizationInput,
  ): Promise<ProvisionOrganizationResult> {
    return this.provisionOrganization.execute(actor, body);
  }

  /**
   * Convite de admin para um hospital JÁ EXISTENTE (ex.: semeado via
   * seed-cnes-hospitals.mjs, sem admin nenhum). Ver
   * InviteHospitalAdminUseCase -- distinto de provision() acima, que
   * sempre cria organização nova junto com o convite.
   */
  @Post("organizations/:id/admins")
  @Roles(UserRole.SUPERADMIN)
  async inviteAdmin(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: InviteHospitalAdminInput,
  ): Promise<InviteHospitalAdminResult> {
    return this.inviteHospitalAdmin.execute(actor, id, body);
  }

  /**
   * Lista TODOS os hospitais -- leitura cross-tenant restrita ao
   * SUPERADMIN (E-2, T-2.1.2). Só leitura: nenhuma via de escrita em
   * nome de um hospital é exposta por esta rota.
   */
  @Get("organizations")
  @Roles(UserRole.SUPERADMIN)
  async list() {
    return this.listOrganizations.execute();
  }

  /** Perfil do PRÓPRIO hospital do hospital_admin autenticado (BP-2026-07-12-001). */
  @Get("organizations/me")
  @Roles(UserRole.HOSPITAL_ADMIN)
  async getMe(@CurrentUser() actor: AuthenticatedUser): Promise<OrganizationProfileDto> {
    return this.getOrganizationProfile.execute(actor);
  }

  /** Edição do perfil do PRÓPRIO hospital do hospital_admin autenticado (BP-2026-07-12-001). */
  @Patch("organizations/me")
  @Roles(UserRole.HOSPITAL_ADMIN)
  async updateMe(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: UpdateOrganizationProfileInput,
  ): Promise<OrganizationProfileDto> {
    return this.updateOrganizationProfile.execute(actor, body);
  }

  /**
   * Detalhe operacional (profile + plantões + candidaturas +
   * credenciais) de UM hospital escolhido pelo SUPERADMIN.
   *
   * IMPORTANTE: declarada DEPOIS de "organizations/me" (Nest/Express
   * casam rotas na ordem de declaração -- uma rota ":id" antes de "me"
   * capturaria "me" como um id literal). Sufixo "/detail" usado
   * deliberadamente em vez de "organizations/:id" puro, para não
   * colidir semanticamente com uma futura rota de edição por id -- que
   * não existe e não deve existir neste épico (só leitura).
   */
  @Get("organizations/:id/detail")
  @Roles(UserRole.SUPERADMIN)
  async getDetail(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
    return this.getOrganizationDetail.execute(actor, id);
  }

  /**
   * Cidades com hospital cadastrado (BP-2026-07-13-001, E-3). Não é
   * dado sensível -- mesmo metadado que já apareceria numa busca de
   * plantões -- por isso acessível aos 3 papéis autenticados.
   */
  @Get("cities")
  @Roles(UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN, UserRole.SUPERADMIN)
  async listCities(): Promise<CityDto[]> {
    return this.listCitiesUseCase.execute();
  }
}
