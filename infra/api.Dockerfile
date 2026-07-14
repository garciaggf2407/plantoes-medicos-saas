# Imagem única (build + runtime) para @plantoes/api. Também serve o
# serviço "worker" do compose (mesma imagem, comando/env diferentes)
# e o serviço one-off "migrate" (mesma imagem, comando diferente) —
# um monorepo pnpm com "workspace:*" não se beneficia de multi-stage
# aqui, porque o build de @plantoes/api depende de @plantoes/shared
# presente como fonte no workspace, não como pacote publicado.
FROM node:22-bookworm-slim

# openssl é exigido pelo query engine do Prisma em runtime (glibc,
# não musl/alpine — evita a classe de bug "engine not found" comum
# em imagens Alpine com versões antigas do Prisma).
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Pinado na mesma versão usada para gerar pnpm-lock.yaml (ver
# .planning/STATE.md) — sem isso, "corepack enable" sozinho pode
# resolver outra versão do pnpm e o --frozen-lockfile abaixo falhar.
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate

WORKDIR /repo

# Copia primeiro só os manifests (cache de camada do Docker: só
# reinstala dependências quando package.json/lockfile mudam, não a
# cada mudança de código-fonte).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @plantoes/shared build
RUN pnpm --filter @plantoes/api exec prisma generate --schema=prisma/schema.prisma
RUN pnpm --filter @plantoes/api build

COPY infra/entrypoint-migrate.sh /usr/local/bin/entrypoint-migrate.sh
RUN chmod +x /usr/local/bin/entrypoint-migrate.sh

ENV NODE_ENV=production
WORKDIR /repo/apps/api
EXPOSE 3001

# Comando padrão do serviço "api"/"worker" — o serviço "migrate" do
# compose sobrescreve com entrypoint-migrate.sh (ver docker-compose.yml).
CMD ["node", "dist/main.js"]
