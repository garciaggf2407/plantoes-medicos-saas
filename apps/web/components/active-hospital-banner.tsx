import type { MeResponse } from "@plantoes/shared";

/** Hospital ativo sempre visível na tela — requisito de QA das telas administrativas. */
export function ActiveHospitalBanner({ me }: { me: MeResponse }) {
  return (
    <div className="mb-4 rounded border bg-gray-50 px-3 py-2 text-sm">
      <span className="font-medium">Hospital ativo:</span> {me.organizationName ?? "—"}
    </div>
  );
}
