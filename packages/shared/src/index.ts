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
