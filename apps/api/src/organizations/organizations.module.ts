import { Global, Module } from "@nestjs/common";
import { TenantContextService } from "./tenant-context";
import { ProvisionOrganizationUseCase } from "./provision-organization.use-case";
import { OrganizationsController } from "./organizations.controller";

@Global()
@Module({
  controllers: [OrganizationsController],
  providers: [TenantContextService, ProvisionOrganizationUseCase],
  exports: [TenantContextService],
})
export class OrganizationsModule {}
