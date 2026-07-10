import { Global, Module } from "@nestjs/common";
import { TenantContextService } from "./tenant-context";

@Global()
@Module({
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class OrganizationsModule {}
