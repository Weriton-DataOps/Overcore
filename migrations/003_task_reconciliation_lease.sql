ALTER TABLE overcore_tasks
  ADD COLUMN IF NOT EXISTS reconciliation_owner text,
  ADD COLUMN IF NOT EXISTS reconciliation_token text,
  ADD COLUMN IF NOT EXISTS reconciliation_until timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'overcore_tasks_reconciliation_lease_complete'
  ) THEN
    ALTER TABLE overcore_tasks
      ADD CONSTRAINT overcore_tasks_reconciliation_lease_complete CHECK (
        (reconciliation_owner IS NULL AND reconciliation_token IS NULL AND reconciliation_until IS NULL)
        OR
        (reconciliation_owner IS NOT NULL AND reconciliation_token IS NOT NULL AND reconciliation_until IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS overcore_tasks_reconciliation_idx
  ON overcore_tasks (status, reconciliation_until, updated_at)
  WHERE status IN ('accepted', 'planning', 'ready');

COMMENT ON COLUMN overcore_tasks.reconciliation_token IS
  'Lease operacional efêmera; não é estado de domínio e expira para permitir retomada após queda.';
