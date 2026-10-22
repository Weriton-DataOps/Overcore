-- A mudança de repositório (ADR-022) grava o próprio recibo de execução para
-- que a redelivery da outbox não chame o editor de novo depois do efeito.
ALTER TABLE overcore_task_execution_receipts
  DROP CONSTRAINT IF EXISTS overcore_task_execution_receipts_payload_check;

ALTER TABLE overcore_task_execution_receipts
  ADD CONSTRAINT overcore_task_execution_receipts_payload_check
  CHECK ((payload ->> 'kind') IN (
    'inspection-completed',
    'file-replacement-completed',
    'postgres-table-probe-completed',
    'repository-change-completed'
  ));
