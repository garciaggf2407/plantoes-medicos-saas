"use client";

import { useEffect, useState } from "react";
import type { CityDto } from "@plantoes/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";

const SELECT_CLASS =
  "rounded-control border border-separator px-2.5 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Perfil do médico só o suficiente para saber a cidade cadastrada e
 * para reenviar os campos obrigatórios ao persistir uma nova cidade
 * (PUT /doctors/me/profile não é um patch parcial — crmNumber e
 * specialties precisam vir junto, mesmo sem mudar). null quando o
 * médico ainda não tem perfil (dado legado / cadastro incompleto).
 */
interface DoctorProfileResponse {
  crmNumber: string;
  specialties: string[];
  contactPhone: string | null;
  city: string | null;
}

type CitiesState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; cities: CityDto[] };

type ProfileState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; profile: DoctorProfileResponse | null };

type PersistState = "idle" | "saving" | "saved" | { error: string };

interface CitySelectorProps {
  /** Cidade atualmente aplicada na busca (controlado pela URL, via ShiftListing). */
  value: string;
  onChange: (city: string) => void;
}

/**
 * Seletor de cidade para a busca de plantões (BP-2026-07-13-001).
 * Pré-seleciona a cidade cadastrada no perfil do médico quando a busca
 * ainda não tem cidade nenhuma aplicada; sem cidade cadastrada, não
 * assume nada — deixa o seletor vazio e pede escolha explícita (ver
 * mensagem em ShiftListing). Permite também gravar a cidade escolhida
 * como o novo padrão do perfil, sem nunca bloquear a troca livre de
 * cidade na busca em si.
 */
export function CitySelector({ value, onChange }: CitySelectorProps) {
  const [cities, setCities] = useState<CitiesState>({ status: "loading" });
  const [profile, setProfile] = useState<ProfileState>({ status: "loading" });
  const [persist, setPersist] = useState<PersistState>("idle");

  useEffect(() => {
    let cancelled = false;
    apiFetch<CityDto[]>("/cities")
      .then((data) => {
        if (!cancelled) setCities({ status: "ready", cities: data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof ApiError ? `Não foi possível carregar as cidades (erro ${err.status})` : "Não foi possível carregar as cidades";
        setCities({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<DoctorProfileResponse | null>("/doctors/me/profile")
      .then((data) => {
        if (cancelled) return;
        setProfile({ status: "ready", profile: data });
      })
      .catch(() => {
        if (!cancelled) setProfile({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pré-seleção: só age uma vez, quando a busca ainda não tem cidade
  // nenhuma aplicada e o perfil (já carregado) tem uma cidade
  // cadastrada. Nunca sobrescreve uma escolha explícita do médico.
  useEffect(() => {
    if (value || profile.status !== "ready" || !profile.profile?.city) {
      return;
    }
    onChange(profile.profile.city);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  async function handleSetAsDefault() {
    if (profile.status !== "ready" || !profile.profile || !value) {
      return;
    }
    const current = profile.profile;
    setPersist("saving");
    try {
      const updated = await apiFetch<DoctorProfileResponse>("/doctors/me/profile", {
        method: "PUT",
        body: JSON.stringify({
          crmNumber: current.crmNumber,
          specialties: current.specialties,
          contactPhone: current.contactPhone ?? undefined,
          city: value,
        }),
      });
      setProfile({ status: "ready", profile: updated });
      setPersist("saved");
    } catch {
      setPersist({ error: "Não foi possível salvar a cidade no perfil. Tente novamente." });
    }
  }

  if (cities.status === "loading") {
    return <span className="text-sm text-label-secondary">Carregando cidades…</span>;
  }
  if (cities.status === "error") {
    return <span className="text-sm text-negative">{cities.message}</span>;
  }

  const registeredCity = profile.status === "ready" ? (profile.profile?.city ?? null) : null;
  const canOfferSetAsDefault = profile.status === "ready" && profile.profile !== null && value !== "" && value !== registeredCity;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor="city-selector" className="flex flex-col gap-1 text-sm text-label-secondary">
        Cidade
        <select
          id="city-selector"
          value={value}
          onChange={(event) => {
            setPersist("idle");
            onChange(event.target.value);
          }}
          className={SELECT_CLASS}
        >
          <option value="">Selecione uma cidade</option>
          {cities.cities.map((c) => (
            <option key={c.city} value={c.city}>
              {c.city}
            </option>
          ))}
        </select>
      </label>

      {canOfferSetAsDefault && (
        <Button type="button" variant="secondary" size="sm" onClick={handleSetAsDefault} disabled={persist === "saving"}>
          {persist === "saving" ? "Salvando…" : "Usar como minha cidade"}
        </Button>
      )}
      {persist === "saved" && <span className="text-sm text-positive">Cidade salva no perfil.</span>}
      {typeof persist === "object" && persist.error && <span className="text-sm text-negative">{persist.error}</span>}
    </div>
  );
}
