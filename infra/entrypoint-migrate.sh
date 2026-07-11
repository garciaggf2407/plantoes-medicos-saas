#!/bin/sh
# Roda uma única vez por deploy (serviço one-off "migrate" no
# docker-compose), nunca como comando de longa duração dos serviços
# "api"/"worker" — separa deliberadamente "aplicar schema" de "rodar
# a aplicação", para nunca reaplicar migrations sem querer a cada
# restart/rollback de um container de app (ver docs/operations/runbooks.md,
# seção 2 "Rollback": rollback de aplicação nunca deve tocar o schema).
set -eu

: "${DATABASE_URL_MIGRATE:?DATABASE_URL_MIGRATE não definida (precisa de uma role privilegiada, ex.: superusuário)}"
: "${PLANTOES_APP_DB_PASSWORD:?PLANTOES_APP_DB_PASSWORD não definida}"

echo "[migrate] aplicando migrations do Prisma..."
DATABASE_URL="$DATABASE_URL_MIGRATE" pnpm exec prisma migrate deploy --schema=prisma/schema.prisma

# A role de runtime "plantoes_app" é criada SEM senha pela migration
# app_role_grants (fail-closed por design — ver o comentário no
# arquivo dessa migration). Definir a senha aqui, via variável de
# ambiente, é o único jeito de deixar "docker compose up" funcionar
# como um único comando numa máquina limpa sem hardcodar segredo
# nenhum na imagem ou no compose. Interpolação feita pelo shell (não
# pela sintaxe :'var' do psql, que não se comportou como esperado em
# testes) -- por isso PLANTOES_APP_DB_PASSWORD não pode conter aspas
# simples (ver infra/.env.example).
echo "[migrate] definindo senha da role de runtime plantoes_app..."
psql "$DATABASE_URL_MIGRATE" -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE plantoes_app WITH PASSWORD '${PLANTOES_APP_DB_PASSWORD}';"

echo "[migrate] concluído."
