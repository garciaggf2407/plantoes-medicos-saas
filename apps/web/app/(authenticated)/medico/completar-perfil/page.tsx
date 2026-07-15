"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { CityDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { PageHeader } from "@/components/ui/page-header";

const INPUT_CLASS =
  "w-full rounded-control border border-separator px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

type CitiesState = { status: "loading" } | { status: "error" } | { status: "ready"; cities: CityDto[] };

/**
 * Gate pós-login real (OIDC): resolveOrProvisionUser cria o DOCTOR só
 * com email/subject, sem CRM/especialidades -- esta tela completa o
 * que o antigo /cadastro (double local) coletava num passo só antes de
 * existir sessão. Ver home (app/page.tsx) para o redirect que traz o
 * médico aqui quando GET /doctors/me/profile ainda é null.
 */
export default function CompletarPerfilPage() {
  const router = useRouter();
  const [cities, setCities] = useState<CitiesState>({ status: "loading" });
  const [form, setForm] = useState({ crmNumber: "", specialties: "", contactPhone: "", city: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<CityDto[]>("/cities")
      .then((data) => setCities({ status: "ready", cities: data }))
      .catch(() => setCities({ status: "error" }));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/doctors/me/profile", {
        method: "PUT",
        body: JSON.stringify({
          crmNumber: form.crmNumber,
          specialties: form.specialties.split(",").map((s) => s.trim()).filter(Boolean),
          contactPhone: form.contactPhone.trim() || undefined,
          city: form.city || undefined,
        }),
      });
      router.push("/");
      router.refresh();
    } catch (err) {
      const message = err instanceof ApiError && typeof err.body === "object" && err.body !== null && "message" in err.body
        ? String((err.body as { message: unknown }).message)
        : "Não foi possível salvar o perfil. Tente novamente.";
      setError(message);
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title="Complete seu perfil" description="Precisamos do seu CRM e especialidades antes de buscar plantões." />
      <Card>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-label-secondary">
            CRM
            <input
              required
              value={form.crmNumber}
              onChange={(e) => setForm({ ...form, crmNumber: e.target.value })}
              className={INPUT_CLASS}
              placeholder="CRM-SP-123456"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-label-secondary">
            Especialidades (separadas por vírgula)
            <input
              required
              value={form.specialties}
              onChange={(e) => setForm({ ...form, specialties: e.target.value })}
              className={INPUT_CLASS}
              placeholder="Cardiologia, Clínica Geral"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-label-secondary">
            Telefone de contato (opcional)
            <input
              value={form.contactPhone}
              onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
              className={INPUT_CLASS}
              placeholder="(11) 91234-5678"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-label-secondary">
            Cidade (opcional)
            {cities.status === "loading" && <LoadingState />}
            {cities.status === "error" && <ErrorState message="Não foi possível carregar as cidades." />}
            {cities.status === "ready" && (
              <select value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className={INPUT_CLASS}>
                <option value="">Selecione uma cidade</option>
                {cities.cities.map((c) => (
                  <option key={c.city} value={c.city}>
                    {c.city}
                  </option>
                ))}
              </select>
            )}
          </label>
          {error && <ErrorState message={error} />}
          <div className="mt-1">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Salvando…" : "Salvar e continuar"}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
