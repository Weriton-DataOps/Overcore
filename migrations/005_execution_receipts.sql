-- O recibo separa o resultado obtido pelo executor da conclusao do Task State.
-- Se o processo cair entre essas duas operacoes, a outbox reentregue reutiliza o
-- resultado persistido em vez de chamar novamente o executor.
CREATE TABLE IF NOT EXISTS overcore_task_execution_receipts (
  receipt_id text PRIMARY KEY,
  outbox_id text NOT NULL UNIQUE REFERENCES overcore_task_outbox(outbox_id),
  task_id text NOT NULL REFERENCES overcore_tasks(task_id),
  execution_epoch integer NOT NULL CHECK (execution_epoch >= 1),
  payload jsonb NOT NULL,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((payload ->> 'kind') = 'inspection-completed')
);

CREATE INDEX IF NOT EXISTS overcore_task_execution_receipts_task_idx
  ON overcore_task_execution_receipts (task_id, execution_epoch, recorded_at);
