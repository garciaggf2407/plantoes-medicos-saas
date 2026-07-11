# Build+runtime de @plantoes/web. Sem output "standalone" do Next.js
# deliberadamente: a etapa de trace-copy do standalone depende de
# criar symlinks, o que falhou (EPERM) ao verificar localmente neste
# Windows sem modo desenvolvedor/admin -- não foi possível confirmar
# que funcionaria dentro do container Linux sem Docker instalado
# neste ambiente para testar de verdade. Este Dockerfile usa o
# caminho mais simples e comprovado: instalar o workspace inteiro e
# rodar "next start" -- imagem mais pesada, porém sem essa
# dependência não verificada.
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@11.11.0 --activate

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN pnpm --filter @plantoes/shared build

# NEXT_PUBLIC_* é inlinado no bundle do cliente em BUILD time, não em
# runtime -- por isso precisa ser um build ARG, não só uma env var do
# serviço no compose. O valor default abaixo assume que o navegador
# acessa a API pelo host (localhost:3001 publicado), já que o
# navegador não resolve nomes de serviço internos do Docker (ex.:
# "http://api:3001" só funciona para tráfego container-a-container).
# Para um deploy com domínio público real, rebuildar a imagem com
# --build-arg NEXT_PUBLIC_API_URL=https://api.dominio-real.com.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN pnpm --filter @plantoes/web build

ENV NODE_ENV=production
WORKDIR /repo/apps/web
EXPOSE 3000

# -H 0.0.0.0 explícito: não depender do bind default do "next start"
# (varia entre versões) -- sem isso o processo pode escutar só em
# loopback e ficar inacessível de fora do container.
CMD ["pnpm", "start", "--", "-H", "0.0.0.0"]
