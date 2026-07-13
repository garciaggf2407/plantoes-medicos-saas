import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { MeController } from "./me.controller";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";
import { OIDC_PROVIDER } from "./identity.tokens";
import { loadOidcConfig } from "./oidc-config";
import { RealOidcProvider } from "./providers/real-oidc.provider";
import { FakeOidcProvider } from "./providers/fake-oidc.provider";
import type { OidcProvider } from "./interfaces/oidc-provider.interface";
import { CredentialsModule } from "../credentials/credentials.module";

/**
 * Módulo de autenticação OIDC. Seleciona o provedor real quando
 * OIDC_ISSUER_URL está configurado; caso contrário usa o double
 * local (ver ACTIVATION.md — adapters/doubles até CP-5). A aplicação
 * nunca armazena senha: apenas subject/email extraídos do id_token
 * validado pelo provedor.
 *
 * FakeOidcProvider aceita qualquer "code" auto-atestado (ver
 * fake-oidc.provider.ts — só faz base64-decode de "subject:email",
 * zero verificação) — é um double para dev/CI, não um mecanismo de
 * autenticação. Selecioná-lo só por OIDC_ISSUER_URL estar vazia
 * significava que um deploy real que esquecesse essa variável (o
 * default do próprio infra/docker-compose.yml) subia com login
 * inteiramente forjável, inclusive permitindo assumir um convite de
 * admin/superadmin ainda não reclamado. Bug real encontrado em
 * auditoria — corrigido falhando fechado: o double só é aceito
 * quando ALLOW_FAKE_OIDC=true é setado explicitamente. Sem essa
 * variável, a ausência de OIDC_ISSUER_URL agora é um erro de boot,
 * nunca um fallback silencioso.
 */
@Module({
  imports: [CredentialsModule],
  controllers: [AuthController, MeController],
  providers: [
    SessionService,
    AuthService,
    {
      provide: OIDC_PROVIDER,
      useFactory: (): OidcProvider => {
        const config = loadOidcConfig();
        if (config.issuerUrl) {
          return new RealOidcProvider(config);
        }
        if (process.env.ALLOW_FAKE_OIDC !== "true") {
          throw new Error(
            "OIDC_ISSUER_URL não definida e ALLOW_FAKE_OIDC != \"true\" — recusando subir com " +
              "FakeOidcProvider (login forjável) por padrão. Defina OIDC_ISSUER_URL para um provedor " +
              "real, ou ALLOW_FAKE_OIDC=true explicitamente em ambiente local/CI/demo.",
          );
        }
        return new FakeOidcProvider();
      },
    },
  ],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
