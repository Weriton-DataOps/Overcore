-- A segunda operação controlada usa o mesmo journal, mas declara uma mutação
-- de schema PostgreSQL estritamente limitada à sonda temporária.
ALTER TABLE overcore_effect_journal
  DROP CONSTRAINT IF EXISTS overcore_effect_journal_operation_check;

ALTER TABLE overcore_effect_journal
  ADD CONSTRAINT overcore_effect_journal_operation_check
  CHECK (operation IN ('filesystem.modify', 'database.schema.modify'));

ALTER TABLE overcore_task_execution_receipts
  DROP CONSTRAINT IF EXISTS overcore_task_execution_receipts_payload_check;

ALTER TABLE overcore_task_execution_receipts
  ADD CONSTRAINT overcore_task_execution_receipts_payload_check
  CHECK ((payload ->> 'kind') IN (
    'inspection-completed',
    'file-replacement-completed',
    'postgres-table-probe-completed'
  ));
