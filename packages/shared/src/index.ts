export type UserRole = "doctor" | "hospital_admin" | "superadmin";

export interface OrganizationScoped {
  organizationId: string;
}

export interface ShiftHospitalDto {
  name: string;
  city: string | null;
  address: string | null;
  description: string | null;
  photoUrl: string | null;
}

export interface ShiftSummary {
  id: string;
  specialty: string;
  valueCents: number;
  startsAt: string;
  endsAt: string;
  /** Hospital dono do plantão -- necessário para montar o link de detalhe/candidatura quando um item vem de uma busca multi-hospital (por cidade, BP-2026-07-13-001). */
  organizationId: string;
  hospital: ShiftHospitalDto;
}

export interface OrganizationProfileDto {
  name: string;
  timezone: string;
  city: string | null;
  address: string | null;
  description: string | null;
  photoUrl: string | null;
}

export interface SearchShiftsResponse {
  items: ShiftSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CalendarEventDto {
  shiftId: string;
  specialty: string;
  valueCents: number;
  startsAt: string;
  endsAt: string;
  organizationId: string;
  organizationName: string;
  timezone: string;
}

export type ShiftStatusDto = "DRAFT" | "PUBLISHED" | "FILLED" | "CANCELLED";

export interface AdminShiftDto {
  id: string;
  specialty: string;
  valueCents: number;
  startsAt: string;
  endsAt: string;
  status: ShiftStatusDto;
}

export interface MeResponse {
  id: string;
  email: string;
  role: string;
  organizationId: string | null;
  organizationName: string | null;
}

interface DoctorSummaryDto {
  crmNumber: string;
  specialties: string[];
  user: { email: string };
}

export interface PendingCredentialDto {
  id: string;
  createdAt: string;
  doctorProfile: DoctorSummaryDto;
}

export interface PendingApplicationDto {
  id: string;
  appliedAt: string;
  shift: { id: string; specialty: string; valueCents: number; startsAt: string; endsAt: string };
  doctorProfile: DoctorSummaryDto;
}

/** Hospital na listagem cross-tenant do SUPERADMIN (GET /organizations, BP-2026-07-13-001, E-2). */
export interface OrganizationSummaryDto {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
}

export type ApplicationStatusDto = "PENDING" | "APPROVED" | "REJECTED";

/**
 * Candidatura em QUALQUER status (ao contrário de PendingApplicationDto,
 * que só cobre a fila PENDING do hospital_admin) — usada no detalhe
 * cross-tenant do SUPERADMIN (GET /organizations/:id/detail).
 */
export interface ApplicationSummaryDto {
  id: string;
  status: ApplicationStatusDto;
  appliedAt: string;
  decidedAt: string | null;
  shift: { id: string; specialty: string; valueCents: number; startsAt: string; endsAt: string };
  doctorProfile: DoctorSummaryDto;
}

export type CredentialStatusDto = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

/**
 * Credencial em QUALQUER status (ao contrário de PendingCredentialDto,
 * que só cobre a fila PENDING do hospital_admin) — usada no detalhe
 * cross-tenant do SUPERADMIN. Minimização de PII preservada: nunca
 * inclui evidenceUrl, mesma disciplina de PendingCredentialDto.
 */
export interface CredentialSummaryDto {
  id: string;
  status: CredentialStatusDto;
  createdAt: string;
  doctorProfile: DoctorSummaryDto;
}

/**
 * Detalhe operacional de UM hospital para o SUPERADMIN (GET
 * /organizations/:id/detail) — profile completo + todos os plantões
 * (qualquer status) + todas as candidaturas + todas as credenciais.
 * Só leitura: nenhum campo/via de escrita é exposto por este tipo.
 */
export interface OrganizationDetailDto extends OrganizationProfileDto {
  id: string;
  shifts: AdminShiftDto[];
  applications: ApplicationSummaryDto[];
  credentials: CredentialSummaryDto[];
}

/** Cidade com ao menos um hospital cadastrado (GET /cities, BP-2026-07-13-001, E-3). */
export interface CityDto {
  city: string;
  organizationCount: number;
}
