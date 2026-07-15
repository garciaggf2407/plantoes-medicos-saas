#!/usr/bin/env node
// Semeia Organization com hospitais reais do CNES/DataSUS (API pública,
// sem autenticação: https://apidadosabertos.saude.gov.br/cnes/estabelecimentos),
// escopado às cidades do interior de SP que o produto atende. Roda uma
// vez por cidade nova adicionada a CITIES -- não é um sync contínuo.
// Idempotente por (name, city): rodar de novo não duplica hospital já
// semeado.
//
// codigo_municipio: código DATASUS de 6 dígitos (IBGE de 7 dígitos SEM
// o dígito verificador final) -- não é o código IBGE "oficial" usado em
// outras APIs. Ex.: Bauru IBGE=3506003 -> DATASUS=350600.
//
// codigo_tipo_unidade: filtra por tipo de estabelecimento. 5=Hospital
// Geral, 7=Hospital Especializado. Nem todo hospital carrega um desses
// códigos (ex.: Santa Casa de Bauru aparece como tipo 36, "clínica/
// centro de especialidade", no cadastro atual) -- por isso a lista
// gerada deve ser conferida à mão antes de ir para produção, este script
// não pretende ter 100% de recall.
import { PrismaClient } from "@prisma/client";

const APP_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://plantoes_app:plantoes_app_dev_local@localhost:5432/plantoes_medicos?schema=public";
const prisma = new PrismaClient({ datasources: { db: { url: APP_DATABASE_URL } } });

const CNES_BASE_URL = "https://apidadosabertos.saude.gov.br/cnes/estabelecimentos";
const HOSPITAL_TIPO_UNIDADE = [5, 7];
const PAGE_SIZE = 20; // a API ignora limit > 20 e devolve 20 mesmo assim

// Cidades do interior de SP atendidas hoje. Adicionar aqui conforme o
// produto expandir -- codigo_municipio é o código DATASUS de 6 dígitos,
// não o IBGE de 7.
//
// codigo_tipo_unidade (5/7) não distingue rede pública de particular --
// CNES é cadastro obrigatório para QUALQUER estabelecimento de saúde no
// Brasil, público ou privado (é `natureza_juridica`, não `esfera_
// administrativa`, que carrega essa distinção; `esfera_administrativa`
// aqui reflete a esfera de gestão do SUS, não a propriedade). Prova:
// Bauru já trouxe HOSPITAL UNIMED, PRONTOCOR, BENEFICÊNCIA PORTUGUESA e
// SÃO LUCAS (todos privados/filantrópicos) lado a lado com os públicos.
const CITIES = [
  { name: "Bauru", codigoMunicipio: 350600 },
  { name: "Campinas", codigoMunicipio: 350950 },
];

async function fetchHospitalsForCity(codigoMunicipio) {
  const byCnes = new Map();
  for (const tipo of HOSPITAL_TIPO_UNIDADE) {
    let offset = 0;
    for (;;) {
      const url = `${CNES_BASE_URL}?codigo_municipio=${codigoMunicipio}&codigo_tipo_unidade=${tipo}&limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`CNES respondeu HTTP ${res.status} para ${url}`);
      const body = await res.json();
      const page = body.estabelecimentos ?? [];
      if (page.length === 0) break;
      for (const est of page) byCnes.set(est.codigo_cnes, est);
      offset += PAGE_SIZE;
    }
  }
  return [...byCnes.values()];
}

function toAddress(est) {
  const parts = [est.endereco_estabelecimento, est.numero_estabelecimento, est.bairro_estabelecimento]
    .map((p) => (typeof p === "string" ? p.trim() : p))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

async function seedCity(city) {
  const hospitals = await fetchHospitalsForCity(city.codigoMunicipio);
  console.log(`${city.name}: ${hospitals.length} hospital(is) encontrados no CNES`);

  for (const est of hospitals) {
    const name = (est.nome_fantasia || est.nome_razao_social || "").trim();
    if (!name) continue;

    const existing = await prisma.organization.findFirst({ where: { name, city: city.name } });
    if (existing) {
      console.log(`  já existe, ignorando: ${name}`);
      continue;
    }

    await prisma.organization.create({
      data: { name, timezone: "America/Sao_Paulo", city: city.name, address: toAddress(est) },
    });
    console.log(`  criado: ${name}`);
  }
}

async function main() {
  for (const city of CITIES) {
    await seedCity(city);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
