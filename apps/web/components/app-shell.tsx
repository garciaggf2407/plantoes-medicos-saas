"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useMe } from "@/lib/use-me";
import { API_URL, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { ActiveHospitalBanner } from "@/components/active-hospital-banner";

const ROLE_LABEL: Record<string, string> = {
  DOCTOR: "Médico",
  HOSPITAL_ADMIN: "Administrador hospitalar",
  SUPERADMIN: "Superadmin",
};

async function handleLogout() {
  const result = await apiFetch<{ providerLogoutUrl: string | null }>("/auth/logout", { method: "POST" }).catch(
    () => null,
  );
  window.location.href = result?.providerLogoutUrl ?? "/";
}

/**
 * Header persistente para toda página autenticada (/medico/*, /admin/*).
 * Gateia o conteúdo protegido: sem sessão válida, mostra o prompt de
 * login em vez de renderizar children com um header quebrado — nenhuma
 * página do grupo precisa checar autenticação por conta própria.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const state = useMe();

  if (state.status === "loading") {
    return (
      <main className="mx-auto max-w-5xl p-6 md:p-8">
        <LoadingState />
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Plantões Médicos</h1>
        <p role="status" className="text-sm text-slate-600">
          Você não está autenticado.
        </p>
        <a
          href={`${API_URL}/auth/login`}
          className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Entrar
        </a>
      </main>
    );
  }

  const { me } = state;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4 md:px-8">
          <Link href="/" className="text-lg font-semibold text-slate-900">
            Plantões Médicos
          </Link>
          <div className="flex items-center gap-4">
            <div className="text-right text-sm">
              <p className="font-medium text-slate-900">{me.email}</p>
              <p className="text-slate-600">{ROLE_LABEL[me.role] ?? me.role}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={handleLogout}>
              Sair
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-6 md:p-8">
        {me.organizationName && <ActiveHospitalBanner me={me} />}
        {children}
      </main>
    </div>
  );
}
