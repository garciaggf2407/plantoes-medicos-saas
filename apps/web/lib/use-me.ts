"use client";

import { useEffect, useState } from "react";
import type { MeResponse } from "@plantoes/shared";
import { apiFetch } from "./api";

export type UseMeState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; me: MeResponse };

/** Identidade do usuário logado — usado pelas telas de admin para exibir o hospital ativo. */
export function useMe(): UseMeState {
  const [state, setState] = useState<UseMeState>({ status: "loading" });

  useEffect(() => {
    apiFetch<MeResponse>("/me")
      .then((me) => setState({ status: "ready", me }))
      .catch(() => setState({ status: "error" }));
  }, []);

  return state;
}
