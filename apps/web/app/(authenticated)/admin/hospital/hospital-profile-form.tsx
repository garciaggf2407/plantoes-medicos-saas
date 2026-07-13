"use client";

import { useEffect, useRef, useState } from "react";
import type { OrganizationProfileDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { ErrorState } from "@/components/ui/error-state";

const INPUT_CLASS =
  "rounded-control border border-separator px-2.5 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

interface EditableFields {
  city: string;
  address: string;
  description: string;
  photoUrl: string;
}

type ViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; profile: OrganizationProfileDto };

type SubmitState = "idle" | "submitting" | "success" | { error: string };

function toFormValue(value: string | null): string {
  return value ?? "";
}

function isErrorBody(body: unknown): body is { message: string } {
  return typeof body === "object" && body !== null && "message" in body && typeof (body as { message: unknown }).message === "string";
}

export function HospitalProfileForm() {
  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [form, setForm] = useState<EditableFields>({ city: "", address: "", description: "", photoUrl: "" });
  const [submit, setSubmit] = useState<SubmitState>("idle");
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiFetch<OrganizationProfileDto>("/organizations/me")
      .then((profile) => {
        setView({ status: "ready", profile });
        setForm({
          city: toFormValue(profile.city),
          address: toFormValue(profile.address),
          description: toFormValue(profile.description),
          photoUrl: toFormValue(profile.photoUrl),
        });
      })
      .catch(() => setView({ status: "error", message: "Não foi possível carregar os dados do hospital." }));
  }, []);

  useEffect(() => {
    if (submit === "success" || (typeof submit === "object" && submit.error)) {
      resultRef.current?.focus();
    }
  }, [submit]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmit("submitting");
    try {
      const updated = await apiFetch<OrganizationProfileDto>("/organizations/me", {
        method: "PATCH",
        body: JSON.stringify({
          city: form.city,
          address: form.address,
          description: form.description,
          photoUrl: form.photoUrl,
        }),
      });
      setView({ status: "ready", profile: updated });
      setSubmit("success");
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && isErrorBody(err.body)) {
        setSubmit({ error: err.body.message });
      } else {
        setSubmit({ error: "Não foi possível salvar as alterações. Tente novamente." });
      }
    }
  }

  if (view.status === "loading") return <LoadingState />;
  if (view.status === "error") return <ErrorState message={view.message} />;

  const { profile } = view;

  return (
    <div>
      <Card className="mb-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="font-medium text-label-secondary">Nome</dt>
          <dd className="text-label">{profile.name}</dd>
          <dt className="font-medium text-label-secondary">Fuso horário</dt>
          <dd className="text-label">{profile.timezone}</dd>
        </dl>
      </Card>

      <Card>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label htmlFor="city" className="flex flex-col gap-1 text-sm text-label-secondary">
            Cidade
            <input
              id="city"
              type="text"
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
              className={INPUT_CLASS}
            />
          </label>
          <label htmlFor="address" className="flex flex-col gap-1 text-sm text-label-secondary">
            Endereço
            <input
              id="address"
              type="text"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className={INPUT_CLASS}
            />
          </label>
          <label htmlFor="description" className="flex flex-col gap-1 text-sm text-label-secondary">
            Descrição
            <textarea
              id="description"
              rows={4}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className={INPUT_CLASS}
            />
          </label>
          <label htmlFor="photoUrl" className="flex flex-col gap-1 text-sm text-label-secondary">
            URL da foto
            <input
              id="photoUrl"
              type="text"
              placeholder="https://..."
              value={form.photoUrl}
              onChange={(e) => setForm({ ...form, photoUrl: e.target.value })}
              className={INPUT_CLASS}
            />
          </label>

          <div>
            <Button type="submit" disabled={submit === "submitting"}>
              {submit === "submitting" ? "Salvando…" : "Salvar alterações"}
            </Button>
          </div>
        </form>

        {submit === "success" && (
          <div
            ref={resultRef}
            tabIndex={-1}
            role="status"
            className="mt-4 rounded-card bg-positive-bg px-4 py-3 text-sm text-positive"
          >
            Alterações salvas com sucesso.
          </div>
        )}
        {typeof submit === "object" && submit.error && (
          <div ref={resultRef} tabIndex={-1} className="mt-4">
            <ErrorState message={submit.error} />
          </div>
        )}
      </Card>
    </div>
  );
}
