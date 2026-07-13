import { execFileSync } from "node:child_process";
import path from "node:path";

const SCRIPT_PATH = path.resolve(__dirname, "../../../api/scripts/e2e-fixtures.mjs");

/**
 * Invoca apps/api/scripts/e2e-fixtures.mjs, que tem acesso direto ao
 * Prisma para semear/limpar dados de cenário e verificar efeitos sem
 * UI própria (entrega de email). execFileSync (não exec com shell)
 * evita qualquer problema de escaping de argumentos.
 */
function runFixtureScript<T>(args: string[]): T {
  const output = execFileSync("node", [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: process.env,
  });
  return JSON.parse(output) as T;
}

export interface Sc1Fixture {
  orgId: string;
  orgName: string;
  adminSubject: string;
  adminEmail: string;
  doctorSubject: string;
  doctorEmail: string;
  shiftId: string;
  specialty: string;
}

export interface Sc2Fixture {
  orgId: string;
  adminSubject: string;
  adminEmail: string;
  doctorSubject: string;
  doctorEmail: string;
  specialty: string;
}

export interface Sc3Fixture {
  orgAId: string;
  orgBId: string;
  adminASubject: string;
  adminAEmail: string;
  adminBSubject: string;
  adminBEmail: string;
  shiftIdInOrgA: string;
}

export interface Sc4Fixture {
  orgId: string;
  adminSubject: string;
  adminEmail: string;
  doctorSubject: string;
  doctorEmail: string;
  doctorUserId: string;
  specialty: string;
}

export interface Sc5Fixture {
  orgId: string;
  adminSubject: string;
  adminEmail: string;
  shiftId: string;
  application1Id: string;
  application2Id: string;
  doctor1Subject: string;
  doctor2Subject: string;
}

export interface Sc6Fixture {
  orgAId: string;
  orgAName: string;
  cityA: string;
  shiftAId: string;
  orgBId: string;
  orgBName: string;
  cityB: string;
  shiftBId: string;
  adminASubject: string;
  adminAEmail: string;
  superadminSubject: string;
  superadminEmail: string;
  doctorSubject: string;
  doctorEmail: string;
}

export const seedSc1 = () => runFixtureScript<Sc1Fixture>(["seed", "sc1"]);
export const seedSc2 = () => runFixtureScript<Sc2Fixture>(["seed", "sc2"]);
export const seedSc3 = () => runFixtureScript<Sc3Fixture>(["seed", "sc3"]);
export const seedSc4 = () => runFixtureScript<Sc4Fixture>(["seed", "sc4"]);
export const seedSc5 = () => runFixtureScript<Sc5Fixture>(["seed", "sc5"]);
export const seedSc6 = () => runFixtureScript<Sc6Fixture>(["seed", "sc6"]);

export const cleanup = (scenario: "sc1" | "sc2" | "sc3" | "sc4" | "sc5" | "sc6") =>
  runFixtureScript<{ orgIds: string[]; userIds: string[] }>(["cleanup", scenario]);

export const checkNotification = (userId: string, type: string) =>
  runFixtureScript<{ found: boolean; notification: unknown }>(["check-notification", userId, type]);

export const checkEmailDelivery = (organizationId: string, userId: string) =>
  runFixtureScript<{ found: boolean }>(["check-email-delivery", organizationId, userId]);
