import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";
import { OIDC_PROVIDER } from "./identity.tokens";
import { loadOidcConfig } from "./oidc-config";
import { RealOidcProvider } from "./providers/real-oidc.provider";
import { FakeOidcProvider } from "./providers/fake-oidc.provider";
import type { OidcProvider } from "./interfaces/oidc-provider.interface";

/**
 * Módulo de autenticação OIDC. Seleciona o provedor real quando
 * OIDC_ISSUER_URL está configurado; caso contrário usa o double
 * local (ver ACTIVATION.md — adapters/doubles até CP-5). A aplicação
 * nunca armazena senha: apenas subject/email extraídos do id_token
 * validado pelo provedor.
 */
@Module({
  controllers: [AuthController],
  providers: [
    SessionService,
    AuthService,
    {
      provide: OIDC_PROVIDER,
      useFactory: (): OidcProvider => {
        const config = loadOidcConfig();
        return config.issuerUrl ? new RealOidcProvider(config) : new FakeOidcProvider();
      },
    },
  ],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
