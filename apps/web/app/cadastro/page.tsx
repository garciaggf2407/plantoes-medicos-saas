"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";

type Mode = "choose" | "medico" | "hospital";

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
  const [mode, setMode] = useState<Mode>("choose");

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-label">Criar conta</h1>
          <p className="mt-1 text-sm text-label-secondary">
            {mode === "choose" ? "Escolha o tipo de cadastro." : "Preencha os dados abaixo."}
          </p>
        </div>

        {mode === "choose" && (
          <div className="flex flex-col gap-3">
            <ChoiceCard title="Sou médico(a)" description="Cadastre CRM, especialidades e cidade para buscar plantões." onClick={() => setMode("medico")} />
            <ChoiceCard title="Sou hospital" description="Cadastre seu hospital e comece a publicar plantões." onClick={() => setMode("hospital")} />
          </div>
        )}
        {mode === "medico" && <DoctorForm onBack={() => setMode("choose")} />}
        {mode === "hospital" && <HospitalForm onBack={() => setMode("choose")} />}

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

function ChoiceCard({ title, description, onClick }: { title: string; description: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-left">
      <Card className="transition-colors hover:bg-background">
        <div className="font-medium text-label">{title}</div>
        <div className="text-sm text-label-secondary">{description}</div>
      </Card>
    </button>
  );
}

function FormShell({ onBack, error, submitting, submitLabel, onSubmit, children }: {
  onBack: () => void;
  error: string | null;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <Card>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        {children}
        {error && <ErrorState message={error} />}
        <div className="mt-1 flex gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Criando…" : submitLabel}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack} disabled={submitting}>
            Voltar
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DoctorForm({ onBack }: { onBack: () => void }) {
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
    <FormShell onBack={onBack} error={error} submitting={submitting} submitLabel="Criar conta" onSubmit={handleSubmit}>
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
    </FormShell>
  );
}

function HospitalForm({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState({ hospitalName: "", city: "", address: "", adminEmail: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/auth/dev-register/hospital", {
        method: "POST",
        body: JSON.stringify({
          hospitalName: form.hospitalName,
          city: form.city,
          address: form.address.trim() || undefined,
          adminEmail: form.adminEmail,
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
    <FormShell onBack={onBack} error={error} submitting={submitting} submitLabel="Cadastrar hospital" onSubmit={handleSubmit}>
      <label className="flex flex-col gap-1 text-sm text-label-secondary">
        Nome do hospital
        <input
          required
          value={form.hospitalName}
          onChange={(e) => setForm({ ...form, hospitalName: e.target.value })}
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-label-secondary">
        Cidade
        <input required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className={INPUT_CLASS} />
      </label>
      <label className="flex flex-col gap-1 text-sm text-label-secondary">
        Endereço (opcional)
        <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={INPUT_CLASS} />
      </label>
      <label className="flex flex-col gap-1 text-sm text-label-secondary">
        E-mail do administrador
        <input
          required
          type="email"
          value={form.adminEmail}
          onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
          className={INPUT_CLASS}
        />
      </label>
    </FormShell>
  );
}
