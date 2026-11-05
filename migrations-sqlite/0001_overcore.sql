-- Esquema SQLite do Overcore (ADR-023 D5 e D8): estado final equivalente às
-- migrações PostgreSQL 001 a 008. Vale o mesmo comportamento, não a mesma sintaxe.
-- Tempo: texto ISO UTC de 24 caracteres (toISOString). JSON: texto.
-- Colunas da casa: origem_maquina, criado_em, atualizado_em e versao registram a
-- escrita física da linha para o _diario; não substituem as colunas de domínio.

CREATE TABLE overcore_tasks (
  task_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'accepted', 'planning', 'ready', 'running', 'verifying',
    'blocked', 'cancelling', 'cancelled', 'succeeded', 'failed'
  )),
  state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
  execution_epoch INTEGER NOT NULL CHECK (execution_epoch >= 1),
  request_document TEXT NOT NULL,
  state_document TEXT NOT NULL,
  result_document TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  reconciliation_owner TEXT,
  reconciliation_token TEXT,
  reconciliation_until TEXT CHECK (reconciliation_until IS NULL OR reconciliation_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  reconciliation_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_failure_count >= 0),
  reconciliation_retry_at TEXT CHECK (reconciliation_retry_at IS NULL OR reconciliation_retry_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  reconciliation_error_code TEXT,
  reconciliation_error_fingerprint TEXT,
  reconciliation_last_error_at TEXT CHECK (reconciliation_last_error_at IS NULL OR reconciliation_last_error_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  origem_maquina TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao >= 1),
  CHECK (json_extract(state_document, '$.taskId') = task_id),
  CHECK (json_extract(state_document, '$.stateRevision') = state_revision),
  CHECK (json_extract(state_document, '$.lifecycle.state') = status),
  CHECK (
    (reconciliation_owner IS NULL AND reconciliation_token IS NULL AND reconciliation_until IS NULL)
    OR
    (reconciliation_owner IS NOT NULL AND reconciliation_token IS NOT NULL AND reconciliation_until IS NOT NULL)
  ),
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
  )
);

CREATE INDEX overcore_tasks_scope_status_idx ON overcore_tasks (scope_key, status, updated_at);
CREATE INDEX overcore_tasks_reconciliation_idx ON overcore_tasks (status, reconciliation_until, updated_at)
  WHERE status IN ('accepted', 'planning', 'ready');
CREATE INDEX overcore_tasks_reconciliation_retry_idx ON overcore_tasks (reconciliation_retry_at, updated_at)
  WHERE status IN ('accepted', 'planning', 'ready') AND reconciliation_retry_at IS NOT NULL;

CREATE TABLE overcore_task_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES overcore_tasks(task_id),
  state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  origem_maquina TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao = 1),
  UNIQUE (task_id, state_revision, event_id)
);

CREATE INDEX overcore_task_events_task_idx ON overcore_task_events (task_id, state_revision, recorded_at);

CREATE TABLE overcore_task_plans (
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),
  task_id TEXT NOT NULL REFERENCES overcore_tasks(task_id),
  plan_fingerprint TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  origem_maquina TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao = 1),
  PRIMARY KEY (plan_id, plan_revision),
  UNIQUE (task_id, plan_id, plan_revision)
);

CREATE TABLE overcore_task_authorizations (
  decision_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES overcore_tasks(task_id),
  authorization_request_id TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  request_document TEXT NOT NULL,
  decision_document TEXT NOT NULL,
  enforcement_document TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  origem_maquina TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao = 1),
  FOREIGN KEY (plan_id, plan_revision) REFERENCES overcore_task_plans(plan_id, plan_revision)
);

CREATE TABLE overcore_task_outbox (
  outbox_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES overcore_tasks(task_id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  available_at TEXT NOT NULL CHECK (available_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token TEXT,
  worker_id TEXT,
  locked_until TEXT CHECK (locked_until IS NULL OR locked_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  processed_at TEXT CHECK (processed_at IS NULL OR processed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_error_fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  origem_maquina TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao >= 1),
  CHECK ((processed_at IS NULL) OR (claim_token IS NULL AND locked_until IS NULL))
);

CREATE INDEX overcore_task_outbox_claim_idx ON overcore_task_outbox (available_at, created_at)
  WHERE processed_at IS NULL;

CREATE TABLE overcore_preflight_streams (
  draft_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  latest_revision INTEGER NOT NULL CHECK (latest_revision >= 1),
  latest_report_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ready', 'decisions-required', 'not-feasible')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  origem_maquina TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao >= 1)
);

CREATE TABLE overcore_preflight_revisions (
  draft_id TEXT NOT NULL REFERENCES overcore_preflight_streams(draft_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  idempotency_key TEXT NOT NULL,
  draft_fingerprint TEXT NOT NULL CHECK (length(draft_fingerprint) = 71 AND substr(draft_fingerprint, 1, 7) = 'sha256:' AND substr(draft_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'),
  draft_document TEXT NOT NULL,
  report_id TEXT NOT NULL UNIQUE,
  report_fingerprint TEXT NOT NULL CHECK (length(report_fingerprint) = 71 AND substr(report_fingerprint, 1, 7) = 'sha256:' AND substr(report_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'),
  report_document TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'decisions-required', 'not-feasible')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  origem_maquina TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao = 1),
  PRIMARY KEY (draft_id, revision),
  CHECK (json_extract(draft_document, '$.draftId') = draft_id),
  CHECK (json_extract(draft_document, '$.revision') = revision),
  CHECK (json_extract(draft_document, '$.idempotencyKey') = idempotency_key),
  CHECK (json_extract(report_document, '$.reportId') = report_id),
  CHECK (json_extract(report_document, '$.draftId') = draft_id),
  CHECK (json_extract(report_document, '$.draftRevision') = revision),
  CHECK (json_extract(report_document, '$.status') = status)
);

CREATE INDEX overcore_preflight_revisions_report_idx ON overcore_preflight_revisions (report_id);

CREATE TRIGGER overcore_preflight_revisions_immutable
  BEFORE UPDATE ON overcore_preflight_revisions
BEGIN
  SELECT RAISE(ABORT, 'overcore_preflight_revisions is append-only');
END;

CREATE TABLE overcore_task_execution_receipts (
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
    'postgres-table-probe-completed'
  ))
);

CREATE INDEX overcore_task_execution_receipts_task_idx
  ON overcore_task_execution_receipts (task_id, execution_epoch, recorded_at);

CREATE TABLE overcore_effect_journal (
  effect_key TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  target_uri TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('filesystem.modify', 'database.schema.modify')),
  intent_fingerprint TEXT NOT NULL CHECK (length(intent_fingerprint) = 71 AND substr(intent_fingerprint, 1, 7) = 'sha256:' AND substr(intent_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'),
  before_digest TEXT NOT NULL CHECK (length(before_digest) = 71 AND substr(before_digest, 1, 7) = 'sha256:' AND substr(before_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  after_digest TEXT NOT NULL CHECK (length(after_digest) = 71 AND substr(after_digest, 1, 7) = 'sha256:' AND substr(after_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  checkpoint_ref TEXT NOT NULL,
  checkpoint_uri TEXT NOT NULL,
  checkpoint_digest TEXT NOT NULL CHECK (length(checkpoint_digest) = 71 AND substr(checkpoint_digest, 1, 7) = 'sha256:' AND substr(checkpoint_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN (
    'reserved', 'applying', 'confirmed', 'not-applied', 'unknown', 'rolled-back'
  )),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  apply_count INTEGER NOT NULL DEFAULT 0 CHECK (apply_count >= 0),
  reserved_at TEXT NOT NULL CHECK (reserved_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  confirmed_at TEXT CHECK (confirmed_at IS NULL OR confirmed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_observed_digest TEXT CHECK (last_observed_digest IS NULL OR (length(last_observed_digest) = 71 AND substr(last_observed_digest, 1, 7) = 'sha256:' AND substr(last_observed_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  last_error_fingerprint TEXT CHECK (last_error_fingerprint IS NULL OR (length(last_error_fingerprint) = 71 AND substr(last_error_fingerprint, 1, 7) = 'sha256:' AND substr(last_error_fingerprint, 8) NOT GLOB '*[^0-9a-f]*')),
  origem_maquina TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao >= 1)
);

CREATE INDEX overcore_effect_journal_task_idx ON overcore_effect_journal (task_id, reserved_at);
CREATE INDEX overcore_effect_journal_recovery_idx ON overcore_effect_journal (state, updated_at)
  WHERE state IN ('applying', 'unknown');

-- Posse do arquivo por um único processo (ADR-023 D2). Fora do _diario: não é dado da casa.
CREATE TABLE _dono (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  processo TEXT NOT NULL,
  maquina TEXT NOT NULL,
  token TEXT NOT NULL,
  ate TEXT NOT NULL CHECK (ate GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

-- Diário da casa (ADR-023 D8): I/U/D de toda tabela de domínio; U só quando a versão muda.
CREATE TABLE _diario (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tabela TEXT NOT NULL,
  linha TEXT NOT NULL,
  operacao TEXT NOT NULL CHECK (operacao IN ('I', 'U', 'D')),
  versao INTEGER,
  em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER overcore_tasks_diario_i AFTER INSERT ON overcore_tasks
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_tasks', NEW.task_id, 'I', NEW.versao); END;
CREATE TRIGGER overcore_tasks_diario_u AFTER UPDATE ON overcore_tasks WHEN NEW.versao IS NOT OLD.versao
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_tasks', NEW.task_id, 'U', NEW.versao); END;
CREATE TRIGGER overcore_tasks_diario_d AFTER DELETE ON overcore_tasks
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_tasks', OLD.task_id, 'D', OLD.versao); END;

CREATE TRIGGER overcore_task_events_diario_i AFTER INSERT ON overcore_task_events
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_events', NEW.event_id, 'I', NEW.versao); END;
CREATE TRIGGER overcore_task_events_diario_u AFTER UPDATE ON overcore_task_events WHEN NEW.versao IS NOT OLD.versao
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_events', NEW.event_id, 'U', NEW.versao); END;
CREATE TRIGGER overcore_task_events_diario_d AFTER DELETE ON overcore_task_events
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_events', OLD.event_id, 'D', OLD.versao); END;

CREATE TRIGGER overcore_task_plans_diario_i AFTER INSERT ON overcore_task_plans
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_plans', NEW.plan_id || ':' || NEW.plan_revision, 'I', NEW.versao); END;
CREATE TRIGGER overcore_task_plans_diario_u AFTER UPDATE ON overcore_task_plans WHEN NEW.versao IS NOT OLD.versao
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_plans', NEW.plan_id || ':' || NEW.plan_revision, 'U', NEW.versao); END;
CREATE TRIGGER overcore_task_plans_diario_d AFTER DELETE ON overcore_task_plans
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_plans', OLD.plan_id || ':' || OLD.plan_revision, 'D', OLD.versao); END;

CREATE TRIGGER overcore_task_authorizations_diario_i AFTER INSERT ON overcore_task_authorizations
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_authorizations', NEW.decision_id, 'I', NEW.versao); END;
CREATE TRIGGER overcore_task_authorizations_diario_u AFTER UPDATE ON overcore_task_authorizations WHEN NEW.versao IS NOT OLD.versao
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_authorizations', NEW.decision_id, 'U', NEW.versao); END;
CREATE TRIGGER overcore_task_authorizations_diario_d AFTER DELETE ON overcore_task_authorizations
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_authorizations', OLD.decision_id, 'D', OLD.versao); END;

CREATE TRIGGER overcore_task_outbox_diario_i AFTER INSERT ON overcore_task_outbox
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_outbox', NEW.outbox_id, 'I', NEW.versao); END;
CREATE TRIGGER overcore_task_outbox_diario_u AFTER UPDATE ON overcore_task_outbox WHEN NEW.versao IS NOT OLD.versao
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_outbox', NEW.outbox_id, 'U', NEW.versao); END;
CREATE TRIGGER overcore_task_outbox_diario_d AFTER DELETE ON overcore_task_outbox
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_outbox', OLD.outbox_id, 'D', OLD.versao); END;

CREATE TRIGGER overcore_preflight_streams_diario_i AFTER INSERT ON overcore_preflight_streams
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_preflight_streams', NEW.draft_id, 'I', NEW.versao); END;
CREATE TRIGGER overcore_preflight_streams_diario_u AFTER UPDATE ON overcore_preflight_streams WHEN NEW.versao IS NOT OLD.versao
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_preflight_streams', NEW.draft_id, 'U', NEW.versao); END;
CREATE TRIGGER overcore_preflight_streams_diario_d AFTER DELETE ON overcore_preflight_streams
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_preflight_streams', OLD.draft_id, 'D', OLD.versao); END;

CREATE TRIGGER overcore_preflight_revisions_diario_i AFTER INSERT ON overcore_preflight_revisions
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_preflight_revisions', NEW.draft_id || ':' || NEW.revision, 'I', NEW.versao); END;
CREATE TRIGGER overcore_preflight_revisions_diario_d AFTER DELETE ON overcore_preflight_revisions
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_preflight_revisions', OLD.draft_id || ':' || OLD.revision, 'D', OLD.versao); END;

CREATE TRIGGER overcore_task_execution_receipts_diario_i AFTER INSERT ON overcore_task_execution_receipts
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_execution_receipts', NEW.receipt_id, 'I', NEW.versao); END;
CREATE TRIGGER overcore_task_execution_receipts_diario_u AFTER UPDATE ON overcore_task_execution_receipts WHEN NEW.versao IS NOT OLD.versao
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_execution_receipts', NEW.receipt_id, 'U', NEW.versao); END;
CREATE TRIGGER overcore_task_execution_receipts_diario_d AFTER DELETE ON overcore_task_execution_receipts
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_task_execution_receipts', OLD.receipt_id, 'D', OLD.versao); END;

CREATE TRIGGER overcore_effect_journal_diario_i AFTER INSERT ON overcore_effect_journal
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_effect_journal', NEW.effect_key, 'I', NEW.versao); END;
CREATE TRIGGER overcore_effect_journal_diario_u AFTER UPDATE ON overcore_effect_journal WHEN NEW.versao IS NOT OLD.versao
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_effect_journal', NEW.effect_key, 'U', NEW.versao); END;
CREATE TRIGGER overcore_effect_journal_diario_d AFTER DELETE ON overcore_effect_journal
BEGIN INSERT INTO _diario (tabela, linha, operacao, versao) VALUES ('overcore_effect_journal', OLD.effect_key, 'D', OLD.versao); END;
