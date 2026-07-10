import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AuthModule } from "./identity/auth.module";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthenticationGuard } from "./identity/guards/authentication.guard";
import { AuthorizationGuard } from "./identity/authorization.guard";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AppController],
  providers: [
    AppService,
    // Ordem importa: AuthenticationGuard resolve req.user primeiro;
    // AuthorizationGuard decide o acesso por papel depois.
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
  ],
})
export class AppModule {}
