CREATE TABLE IF NOT EXISTS overcore_tasks (
  task_id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  scope_key text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'accepted', 'planning', 'ready', 'running', 'verifying',
    'blocked', 'cancelling', 'cancelled', 'succeeded', 'failed'
  )),
  state_revision integer NOT NULL CHECK (state_revision >= 1),
  execution_epoch integer NOT NULL CHECK (execution_epoch >= 1),
  request_document jsonb NOT NULL,
  state_document jsonb NOT NULL,
  result_document jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((state_document ->> 'taskId') = task_id),
  CHECK ((state_document ->> 'stateRevision')::integer = state_revision),
  CHECK ((state_document -> 'lifecycle' ->> 'state') = status)
);

CREATE INDEX IF NOT EXISTS overcore_tasks_scope_status_idx
  ON overcore_tasks (scope_key, status, updated_at);

CREATE TABLE IF NOT EXISTS overcore_task_events (
  event_id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES overcore_tasks(task_id),
  state_revision integer NOT NULL CHECK (state_revision >= 1),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, state_revision, event_id)
);

CREATE INDEX IF NOT EXISTS overcore_task_events_task_idx
  ON overcore_task_events (task_id, state_revision, recorded_at);

CREATE TABLE IF NOT EXISTS overcore_task_plans (
  plan_id text NOT NULL,
  plan_revision integer NOT NULL CHECK (plan_revision >= 1),
  task_id text NOT NULL REFERENCES overcore_tasks(task_id),
  plan_fingerprint text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (plan_id, plan_revision),
  UNIQUE (task_id, plan_id, plan_revision)
);

CREATE TABLE IF NOT EXISTS overcore_task_authorizations (
  decision_id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES overcore_tasks(task_id),
  authorization_request_id text NOT NULL UNIQUE,
  plan_id text NOT NULL,
  plan_revision integer NOT NULL,
  expires_at timestamptz NOT NULL,
  request_document jsonb NOT NULL,
  decision_document jsonb NOT NULL,
  enforcement_document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (plan_id, plan_revision) REFERENCES overcore_task_plans(plan_id, plan_revision)
);

CREATE TABLE IF NOT EXISTS overcore_task_outbox (
  outbox_id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES overcore_tasks(task_id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token text,
  worker_id text,
  locked_until timestamptz,
  processed_at timestamptz,
  last_error_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((processed_at IS NULL) OR (claim_token IS NULL AND locked_until IS NULL))
);

CREATE INDEX IF NOT EXISTS overcore_task_outbox_claim_idx
  ON overcore_task_outbox (available_at, created_at)
  WHERE processed_at IS NULL;
