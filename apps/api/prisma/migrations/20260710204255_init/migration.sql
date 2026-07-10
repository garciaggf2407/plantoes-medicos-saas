-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('DOCTOR', 'HOSPITAL_ADMIN', 'SUPERADMIN');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'FILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "oidc_subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "organization_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "crm_number" TEXT NOT NULL,
    "specialties" TEXT[],
    "contact_phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "doctor_profile_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "evidence_url" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_user_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "justification" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "value_cents" INTEGER NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "doctor_profile_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by_user_id" TEXT,
    "justification" TEXT,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "actor_user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "justification" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_oidc_subject_key" ON "users"("oidc_subject");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_organization_id_idx" ON "users"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_profiles_user_id_key" ON "doctor_profiles"("user_id");

-- CreateIndex
CREATE INDEX "credentials_organization_id_idx" ON "credentials"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_doctor_profile_id_organization_id_key" ON "credentials"("doctor_profile_id", "organization_id");

-- CreateIndex
CREATE INDEX "shifts_organization_id_status_idx" ON "shifts"("organization_id", "status");

-- CreateIndex
CREATE INDEX "shifts_organization_id_specialty_value_cents_idx" ON "shifts"("organization_id", "specialty", "value_cents");

-- CreateIndex
CREATE INDEX "applications_organization_id_idx" ON "applications"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "applications_shift_id_doctor_profile_id_key" ON "applications"("shift_id", "doctor_profile_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_organization_id_idx" ON "notifications"("organization_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_idx" ON "audit_logs"("organization_id");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
