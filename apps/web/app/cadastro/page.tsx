"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";

const INPUT_CLASS =
  "w-full rounded-control border border-separator px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** Mensagem cru do backend (ver auth.service.ts) → texto amigável. */
function friendlyError(err: unknown): string {
  if (err instanceof ApiError && err.status === 400) {
    const message =
      typeof err.body === "object" && err.body !== null && "message" in err.body
        ? (err.body as { message: unknown }).message
        : null;
    if (typeof message === "string" && message.includes("já_existe_conta")) {
      return "Já existe uma conta com este e-mail. Tente entrar em vez de cadastrar.";
    }
    if (typeof message === "string") {
      return message;
    }
  }
  return "Não foi possível criar a conta. Tente novamente.";
}

export default function CadastroPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", crmNumber: "", specialties: "", city: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/auth/dev-register/doctor", {
        method: "POST",
        body: JSON.stringify({
          email: form.email,
          crmNumber: form.crmNumber,
          specialties: form.specialties.split(",").map((s) => s.trim()).filter(Boolean),
          city: form.city.trim() || undefined,
        }),
      });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(friendlyError(err));
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-label">Criar conta de médico(a)</h1>
          <p className="mt-1 text-sm text-label-secondary">Cadastre CRM, especialidades e cidade para buscar plantões.</p>
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm text-label-secondary">
              E-mail
              <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={INPUT_CLASS} />
            </label>
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
              Cidade (opcional)
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className={INPUT_CLASS} placeholder="Bauru" />
            </label>
            {error && <ErrorState message={error} />}
            <div className="mt-1">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Criando…" : "Criar conta"}
              </Button>
            </div>
          </form>
        </Card>

        <p className="mt-6 text-center text-sm text-label-secondary">
          Já tem conta?{" "}
          <Link href="/login" className="font-medium text-accent hover:text-accent-hover">
            Entrar
          </Link>
        </p>
      </div>
    </main>
  );
}
