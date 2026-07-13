"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useMe } from "@/lib/use-me";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { ActiveHospitalBanner } from "@/components/active-hospital-banner";

const ROLE_LABEL: Record<string, string> = {
  DOCTOR: "Médico",
  HOSPITAL_ADMIN: "Administrador hospitalar",
  SUPERADMIN: "Superadmin",
};

/**
 * Motivo cru de OidcCallbackError (ver auth.service.ts) → mensagem amigável.
 * Sempre que o código/state de um login é reusado (ex.: botão "voltar" do
 * navegador reabrindo uma página de login já concluída), a API redireciona
 * pra cá com `auth_error` na query em vez de travar num JSON cru.
 */
function authErrorMessage(reason: string): string {
  if (reason === "email_already_claimed") {
    return "Este e-mail já está associado a outra conta. Fale com o administrador do hospital.";
  }
  return "O link de login expirou ou já foi usado (comum ao clicar em \"voltar\" no navegador depois de já ter entrado). Clique em Entrar para tentar de novo.";
}

/** Lê `auth_error` da URL uma vez e limpa a query, sem afetar SSR (só roda no cliente). */
function useAuthErrorMessage(): string | null {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("auth_error");
    if (!reason) return;
    setMessage(authErrorMessage(reason));
    params.delete("auth_error");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
  }, []);

  return message;
}

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
  const authErrorMessage = useAuthErrorMessage();

  if (state.status === "loading") {
    return (
      <main className="mx-auto max-w-5xl p-6 md:p-8">
        <LoadingState />
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="w-full max-w-sm rounded-card bg-surface p-8 text-center shadow-card">
          <h1 className="text-xl font-semibold text-label">Plantões Médicos</h1>
          <p role="status" className="mt-2 text-sm text-label-secondary">
            Você não está autenticado.
          </p>
          {authErrorMessage && (
            <p role="alert" className="mt-4 rounded-control bg-pending-bg px-4 py-2 text-sm text-pending">
              {authErrorMessage}
            </p>
          )}
          <div className="mt-6 flex items-center justify-center gap-4">
            <Link href="/login" className="rounded-control bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
              Entrar
            </Link>
            <Link href="/cadastro" className="text-sm font-medium text-accent hover:text-accent-hover">
              Cadastre-se
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const { me } = state;

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4 md:px-8">
          <Link href="/" className="text-lg font-semibold text-label">
            Plantões Médicos
          </Link>
          <div className="flex items-center gap-4">
            <div className="text-right text-sm">
              <p className="font-medium text-label">{me.email}</p>
              <p className="text-label-secondary">{ROLE_LABEL[me.role] ?? me.role}</p>
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
