import { Module } from "@nestjs/common";
import { CredentialsController } from "./credentials.controller";
import { CredentialsService } from "./credentials.service";
import { ReviewCredentialUseCase } from "./review-credential.use-case";

@Module({
  controllers: [CredentialsController],
  providers: [CredentialsService, ReviewCredentialUseCase],
  exports: [CredentialsService],
})
export class CredentialsModule {}
