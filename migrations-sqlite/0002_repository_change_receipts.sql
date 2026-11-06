-- Equivalente da 009_repository_change_receipts.sql (ADR-022, Marco 3): o recibo de execução passa a
-- aceitar 'repository-change-completed', para a redelivery da outbox não chamar o editor de novo.
-- O SQLite não altera CHECK: a tabela é reconstruída com as mesmas colunas, chaves, índice e gatilhos
-- do _diario. A cópia não passa pelo diário; os recibos continuam com a mesma chave e versão.

CREATE TABLE overcore_task_execution_receipts_0002 (
  receipt_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES overcore_task_outbox(outbox_id),
  task_id TEXT NOT NULL REFERENCES overcore_tasks(task_id),
  execution_epoch INTEGER NOT NULL CHECK (execution_epoch >= 1),
  payload TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) = 71 AND substr(payload_fingerprint, 1, 7) = 'sha256:' AND substr(payload_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  origem_maquina TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao = 1),
  -- Inclui a sonda PostgreSQL: o motor não a executa, mas o corte importa o histórico.
  CHECK (json_extract(payload, '$.kind') IN (
    'inspection-completed',
    'file-replacement-completed',
    'postgres-table-probe-completed',
    'repository-change-completed'
  ))
);

INSERT INTO overcore_task_execution_receipts_0002 (
  receipt_id, outbox_id, task_id, execution_epoch, payload, payload_fingerprint, recorded_at,
  created_at, origem_maquina, criado_em, versao
)
SELECT receipt_id, outbox_id, task_id, execution_epoch, payload, payload_fingerprint, recorded_at,
  created_at, origem_maquina, criado_em, versao
FROM overcore_task_execution_receipts;

DROP TABLE overcore_task_execution_receipts;
ALTER TABLE overcore_task_execution_receipts_0002 RENAME TO overcore_task_execution_receipts;

CREATE INDEX overcore_task_execution_receipts_task_idx
  ON overcore_task_execution_receipts (task_id, execution_epoch, recorded_at);

CREATE TRIGGER overcore_task_execution_receipts_diario_i AFTER INSERT ON overcore_task_execution_receipts
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_execution_receipts', NEW.receipt_id, 'I', NEW.versao); END;
CREATE TRIGGER overcore_task_execution_receipts_diario_u AFTER UPDATE ON overcore_task_execution_receipts WHEN NEW.versao IS NOT OLD.versao
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_execution_receipts', NEW.receipt_id, 'U', NEW.versao); END;
CREATE TRIGGER overcore_task_execution_receipts_diario_d AFTER DELETE ON overcore_task_execution_receipts
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_execution_receipts', OLD.receipt_id, 'D', OLD.versao); END;
