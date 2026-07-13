import { Global, Module } from "@nestjs/common";
import { TenantContextService } from "./tenant-context";
import { ProvisionOrganizationUseCase } from "./provision-organization.use-case";
import { GetOrganizationProfileUseCase } from "./get-organization-profile.use-case";
import { UpdateOrganizationProfileUseCase } from "./update-organization-profile.use-case";
import { ListOrganizationsUseCase } from "./list-organizations.use-case";
import { GetOrganizationDetailUseCase } from "./get-organization-detail.use-case";
import { ListCitiesUseCase } from "./list-cities.use-case";
import { OrganizationsController } from "./organizations.controller";

@Global()
@Module({
  controllers: [OrganizationsController],
  providers: [
    TenantContextService,
    ProvisionOrganizationUseCase,
    GetOrganizationProfileUseCase,
    UpdateOrganizationProfileUseCase,
    ListOrganizationsUseCase,
    GetOrganizationDetailUseCase,
    ListCitiesUseCase,
  ],
  exports: [TenantContextService, ListCitiesUseCase],
})
export class OrganizationsModule {}
