import type { MeResponse } from "@plantoes/shared";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/** Hospital ativo sempre visível na tela — requisito de QA das telas administrativas. */
export function ActiveHospitalBanner({ me }: { me: MeResponse }) {
  return (
    <Card className="mb-4 flex items-center gap-3 py-3">
      <Badge variant="positive">Ativo</Badge>
      <span className="text-sm text-slate-900">
        <span className="font-medium">Hospital:</span> {me.organizationName ?? "—"}
      </span>
    </Card>
  );
}
