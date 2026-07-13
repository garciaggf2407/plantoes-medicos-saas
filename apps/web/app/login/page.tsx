"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { ErrorState } from "@/components/ui/error-state";

interface DevAccount {
  email: string;
  role: "DOCTOR" | "HOSPITAL_ADMIN" | "SUPERADMIN";
  organizationName: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  DOCTOR: "Médico",
  HOSPITAL_ADMIN: "Administrador hospitalar",
  SUPERADMIN: "Superadmin",
};

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; accounts: DevAccount[] };

export default function LoginPage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [submittingEmail, setSubmittingEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<DevAccount[]>("/auth/dev-accounts")
      .then((accounts) => setState({ status: "ready", accounts }))
      .catch(() => setState({ status: "error", message: "Não foi possível carregar as contas." }));
  }, []);

  async function handleLogin(email: string) {
    setSubmittingEmail(email);
    setError(null);
    try {
      await apiFetch("/auth/dev-quick-login", { method: "POST", body: JSON.stringify({ email }) });
      router.push("/");
      router.refresh();
    } catch {
      setError("Não foi possível entrar com esta conta. Tente novamente.");
      setSubmittingEmail(null);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-label">Plantões Médicos</h1>
          <p className="mt-1 text-sm text-label-secondary">Entre com uma conta existente.</p>
        </div>

        {state.status === "loading" && <LoadingState />}
        {state.status === "error" && <ErrorState message={state.message} />}
        {state.status === "ready" && state.accounts.length === 0 && (
          <ErrorState message="Nenhuma conta cadastrada ainda." />
        )}
        {state.status === "ready" && state.accounts.length > 0 && (
          <Card className="flex flex-col gap-1 p-2">
            {state.accounts.map((account) => (
              <button
                key={account.email}
                type="button"
                disabled={submittingEmail !== null}
                onClick={() => handleLogin(account.email)}
                className="flex w-full items-center justify-between gap-3 rounded-control px-3 py-2.5 text-left transition-colors hover:bg-background disabled:opacity-50"
              >
                <span>
                  <span className="block text-sm font-medium text-label">{account.email}</span>
                  {account.organizationName && (
                    <span className="block text-xs text-label-secondary">{account.organizationName}</span>
                  )}
                </span>
                <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-xs font-medium text-accent">
                  {submittingEmail === account.email ? "Entrando…" : (ROLE_LABEL[account.role] ?? account.role)}
                </span>
              </button>
            ))}
          </Card>
        )}

        {error && (
          <div className="mt-4">
            <ErrorState message={error} />
          </div>
        )}

        <p className="mt-6 text-center text-sm text-label-secondary">
          Não tem conta?{" "}
          <Link href="/cadastro" className="font-medium text-accent hover:text-accent-hover">
            Cadastre-se
          </Link>
        </p>
      </div>
    </main>
  );
}
