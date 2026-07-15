"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMe } from "@/lib/use-me";
import { apiFetch } from "@/lib/api";
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
  const router = useRouter();
  const state = useMe();
  const role = state.status === "ready" ? state.me.role : null;
  const items = role ? NAV_BY_ROLE[role] : undefined;
  const [profileChecked, setProfileChecked] = useState(false);

  // Login real (OIDC) auto-provisiona DOCTOR sem CRM/especialidades
  // (ver resolveOrProvisionUser) -- sem isso, o médico cai na home sem
  // conseguir buscar plantões e sem saber por quê.
  useEffect(() => {
    if (role !== "DOCTOR") {
      setProfileChecked(true);
      return;
    }
    let cancelled = false;
    apiFetch<{ crmNumber: string } | null>("/doctors/me/profile")
      .then((profile) => {
        if (cancelled) return;
        if (profile === null) {
          router.replace("/medico/completar-perfil");
          return;
        }
        setProfileChecked(true);
      })
      .catch(() => {
        if (!cancelled) setProfileChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [role, router]);

  if (role === "DOCTOR" && !profileChecked) {
    return (
      <AppShell>
        <PageHeader title="Bem-vindo(a)" description="Escolha para onde ir." />
      </AppShell>
    );
  }

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
