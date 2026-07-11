"use client";

import Link from "next/link";
import { useMe } from "@/lib/use-me";
import { API_URL, apiFetch } from "@/lib/api";

const ROLE_LABEL: Record<string, string> = {
  DOCTOR: "Médico",
  HOSPITAL_ADMIN: "Administrador hospitalar",
  SUPERADMIN: "Superadmin",
};

function LogoutButton() {
  async function handleLogout() {
    const result = await apiFetch<{ providerLogoutUrl: string | null }>("/auth/logout", { method: "POST" }).catch(
      () => null,
    );
    window.location.href = result?.providerLogoutUrl ?? "/";
  }

  return (
    <button type="button" onClick={handleLogout} className="rounded border px-3 py-1 text-sm">
      Sair
    </button>
  );
}

export default function Home() {
  const state = useMe();

  if (state.status === "loading") {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <p role="status">Carregando…</p>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="mb-2 text-xl font-semibold">Plantões Médicos</h1>
        <p role="status" className="mb-4 text-gray-600">
          Você não está autenticado.
        </p>
        <a href={`${API_URL}/auth/login`} className="inline-block rounded bg-black px-4 py-2 text-white">
          Entrar
        </a>
      </main>
    );
  }

  const { me } = state;

  return (
    <main className="mx-auto max-w-2xl p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Plantões Médicos</h1>
          <p className="text-sm text-gray-600">
            {me.email} · {ROLE_LABEL[me.role] ?? me.role}
            {me.organizationName ? ` · ${me.organizationName}` : ""}
          </p>
        </div>
        <LogoutButton />
      </div>

      {me.role === "DOCTOR" && (
        <nav aria-label="Navegação do médico" className="flex flex-col gap-3">
          <Link href="/medico/plantoes" className="rounded border p-3 font-medium hover:bg-gray-50">
            Plantões disponíveis
          </Link>
          <Link href="/medico/calendario" className="rounded border p-3 font-medium hover:bg-gray-50">
            Minha agenda
          </Link>
        </nav>
      )}

      {me.role === "HOSPITAL_ADMIN" && (
        <nav aria-label="Navegação do administrador" className="flex flex-col gap-3">
          <Link href="/admin/plantoes" className="rounded border p-3 font-medium hover:bg-gray-50">
            Gestão de plantões
          </Link>
          <Link href="/admin/revisao" className="rounded border p-3 font-medium hover:bg-gray-50">
            Fila de revisão
          </Link>
          <Link href="/admin/calendario" className="rounded border p-3 font-medium hover:bg-gray-50">
            Calendário da unidade
          </Link>
        </nav>
      )}

      {me.role === "SUPERADMIN" && (
        <p className="text-sm text-gray-600">
          Ações de superadmin (provisionar hospital) ainda não têm interface — disponíveis via API
          (<code>POST /organizations</code>).
        </p>
      )}
    </main>
  );
}
