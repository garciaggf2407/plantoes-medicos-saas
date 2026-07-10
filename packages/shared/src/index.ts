export type UserRole = "doctor" | "hospital_admin" | "superadmin";

export interface OrganizationScoped {
  organizationId: string;
}
