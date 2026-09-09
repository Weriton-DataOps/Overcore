-- Journal durável do Harness de efeitos. O conteúdo do checkpoint fica fora do
-- banco; aqui permanecem identidade, localização, hashes e estado recuperável.
CREATE TABLE IF NOT EXISTS overcore_effect_journal (
  effect_key text PRIMARY KEY,
  effect_id text NOT NULL UNIQUE,
  task_id text NOT NULL,
  resource_ref text NOT NULL,
  target_uri text NOT NULL,
  operation text NOT NULL CHECK (operation = 'filesystem.modify'),
  intent_fingerprint text NOT NULL CHECK (intent_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  before_digest text NOT NULL CHECK (before_digest ~ '^sha256:[0-9a-f]{64}$'),
  after_digest text NOT NULL CHECK (after_digest ~ '^sha256:[0-9a-f]{64}$'),
  checkpoint_ref text NOT NULL,
  checkpoint_uri text NOT NULL,
  checkpoint_digest text NOT NULL CHECK (checkpoint_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN (
    'reserved', 'applying', 'confirmed', 'not-applied', 'unknown', 'rolled-back'
  )),
  revision integer NOT NULL CHECK (revision >= 1),
  apply_count integer NOT NULL DEFAULT 0 CHECK (apply_count >= 0),
  reserved_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  last_observed_digest text CHECK (
    last_observed_digest IS NULL OR last_observed_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  last_error_fingerprint text CHECK (
    last_error_fingerprint IS NULL OR last_error_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS overcore_effect_journal_task_idx
  ON overcore_effect_journal (task_id, reserved_at);

CREATE INDEX IF NOT EXISTS overcore_effect_journal_recovery_idx
  ON overcore_effect_journal (state, updated_at)
  WHERE state IN ('applying', 'unknown');
