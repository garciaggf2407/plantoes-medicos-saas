"use client";

import Link from "next/link";
import { useMe } from "@/lib/use-me";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

const NAV_BY_ROLE: Record<string, Array<{ href: string; label: string }>> = {
  DOCTOR: [
    { href: "/medico/plantoes", label: "Plantões disponíveis" },
    { href: "/medico/calendario", label: "Minha agenda" },
  ],
  HOSPITAL_ADMIN: [
    { href: "/admin/plantoes", label: "Gestão de plantões" },
    { href: "/admin/revisao", label: "Fila de revisão" },
    { href: "/admin/calendario", label: "Calendário da unidade" },
    { href: "/admin/hospital", label: "Perfil do hospital" },
  ],
  SUPERADMIN: [{ href: "/admin/superadmin", label: "Todos os hospitais" }],
};

export default function Home() {
  const state = useMe();
  const role = state.status === "ready" ? state.me.role : null;
  const items = role ? NAV_BY_ROLE[role] : undefined;

  return (
    <AppShell>
      <PageHeader title="Bem-vindo(a)" description="Escolha para onde ir." />

      {items && (
        <nav aria-label="Navegação principal" className="flex flex-col gap-3">
          {items.map((item) => (
            <Link key={item.href} href={item.href}>
              <Card className="font-medium text-label transition-colors hover:bg-background">{item.label}</Card>
            </Link>
          ))}
        </nav>
      )}

      {role === "SUPERADMIN" && (
        <p className="text-sm text-label-secondary">
          Provisionar um novo hospital ainda não tem interface — disponível via API
          (<code>POST /organizations</code>). Visualizar hospitais já provisionados está disponível acima.
        </p>
      )}
    </AppShell>
  );
}
