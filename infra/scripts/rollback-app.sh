#!/bin/sh
# Rollback de aplicação (ver docs/operations/runbooks.md, seção 2).
# Troca a imagem em execução por uma tag anterior conhecida-boa.
# NUNCA toca o schema do banco -- migrations seguem o padrão
# expandir-antes-de-contrair, então uma versão anterior da aplicação
# continua funcionando contra um schema mais novo.
#
# Uso: infra/scripts/rollback-app.sh <tag-anterior-conhecida-boa>
set -eu

if [ "$#" -ne 1 ]; then
  echo "Uso: $0 <tag-anterior-conhecida-boa>" >&2
  echo "Tags disponíveis localmente:" >&2
  docker images --filter "reference=plantoes-api" --format "  {{.Tag}}" >&2
  exit 1
fi

TAG="$1"
COMPOSE_FILE="$(dirname "$0")/../docker-compose.yml"

echo "[rollback] parando os serviços atuais..."
docker compose -f "$COMPOSE_FILE" down

echo "[rollback] subindo com PLANTOES_IMAGE_TAG=$TAG (schema intocado)..."
PLANTOES_IMAGE_TAG="$TAG" docker compose -f "$COMPOSE_FILE" up -d

echo "[rollback] aguardando healthchecks..."
docker compose -f "$COMPOSE_FILE" ps

echo "[rollback] concluído. Validar: GET /health deve retornar 200 e o fluxo que causou o incidente NÃO deve mais ocorrer."
