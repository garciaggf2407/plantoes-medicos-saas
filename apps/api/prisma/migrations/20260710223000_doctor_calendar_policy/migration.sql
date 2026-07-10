-- Calendário do médico precisa agregar plantões aprovados em
-- QUALQUER hospital onde ele atua, mas RLS escopa uma transação a
-- um único organization_id por vez. Solução: uma política adicional
-- (permissiva, combinada por OR com tenant_isolation) que libera
-- SELECT apenas para as linhas do PRÓPRIO médico autenticado,
-- independente do hospital — nunca abre acesso a dados de outros
-- médicos nem a operações de escrita.

-- applications: o médico enxerga suas próprias candidaturas.
CREATE POLICY doctor_self_calendar ON "applications"
  FOR SELECT
  USING (doctor_profile_id = current_setting('app.current_doctor_profile_id', true));

-- shifts: o médico enxerga o plantão referenciado por uma candidatura
-- APROVADA dele — nunca plantões sem candidatura aprovada sua, nunca
-- de outro médico.
CREATE POLICY doctor_self_calendar ON "shifts"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "applications" a
      WHERE a.shift_id = shifts.id
        AND a.doctor_profile_id = current_setting('app.current_doctor_profile_id', true)
        AND a.status = 'APPROVED'
    )
  );
