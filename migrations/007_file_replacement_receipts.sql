-- Um recibo pode representar uma inspeção ou a projeção de uma substituição
-- reversível já confirmada pelo Harness. A migração preserva os recibos
-- existentes e não altera Task State nem a semântica de idempotência.
ALTER TABLE overcore_task_execution_receipts
  DROP CONSTRAINT IF EXISTS overcore_task_execution_receipts_payload_check;

ALTER TABLE overcore_task_execution_receipts
  ADD CONSTRAINT overcore_task_execution_receipts_payload_check
  CHECK ((payload ->> 'kind') IN ('inspection-completed', 'file-replacement-completed'));
