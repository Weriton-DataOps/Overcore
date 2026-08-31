ALTER TABLE overcore_tasks
  ADD COLUMN IF NOT EXISTS reconciliation_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconciliation_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciliation_error_code text,
  ADD COLUMN IF NOT EXISTS reconciliation_error_fingerprint text,
  ADD COLUMN IF NOT EXISTS reconciliation_last_error_at timestamptz;

ALTER TABLE overcore_tasks
  ADD CONSTRAINT overcore_tasks_reconciliation_failure_count_nonnegative
  CHECK (reconciliation_failure_count >= 0);

ALTER TABLE overcore_tasks
  ADD CONSTRAINT overcore_tasks_reconciliation_failure_complete
  CHECK (
    (reconciliation_failure_count = 0
      AND reconciliation_retry_at IS NULL
      AND reconciliation_error_code IS NULL
      AND reconciliation_error_fingerprint IS NULL
      AND reconciliation_last_error_at IS NULL)
    OR
    (reconciliation_failure_count > 0
      AND reconciliation_retry_at IS NOT NULL
      AND reconciliation_error_code IS NOT NULL
      AND reconciliation_error_fingerprint IS NOT NULL
      AND reconciliation_last_error_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS overcore_tasks_reconciliation_retry_idx
  ON overcore_tasks (reconciliation_retry_at, updated_at)
  WHERE status IN ('accepted', 'planning', 'ready')
    AND reconciliation_retry_at IS NOT NULL;

COMMENT ON COLUMN overcore_tasks.reconciliation_retry_at IS
  'Próximo instante operacional de tentativa; não altera o estado de domínio da tarefa.';
