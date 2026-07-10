export type UserRole = "doctor" | "hospital_admin" | "superadmin";

export interface OrganizationScoped {
  organizationId: string;
}

export interface ShiftSummary {
  id: string;
  specialty: string;
  valueCents: number;
  startsAt: string;
  endsAt: string;
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
