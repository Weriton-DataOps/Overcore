CREATE TABLE IF NOT EXISTS overcore_preflight_streams (
  draft_id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  latest_revision integer NOT NULL CHECK (latest_revision >= 1),
  latest_report_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('ready', 'decisions-required', 'not-feasible')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS overcore_preflight_revisions (
  draft_id text NOT NULL REFERENCES overcore_preflight_streams(draft_id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  idempotency_key text NOT NULL,
  draft_fingerprint text NOT NULL CHECK (draft_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  draft_document jsonb NOT NULL,
  report_id text NOT NULL UNIQUE,
  report_fingerprint text NOT NULL CHECK (report_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  report_document jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'decisions-required', 'not-feasible')),
  created_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (draft_id, revision),
  CHECK ((draft_document ->> 'draftId') = draft_id),
  CHECK ((draft_document ->> 'revision')::integer = revision),
  CHECK ((draft_document ->> 'idempotencyKey') = idempotency_key),
  CHECK ((report_document ->> 'reportId') = report_id),
  CHECK ((report_document ->> 'draftId') = draft_id),
  CHECK ((report_document ->> 'draftRevision')::integer = revision),
  CHECK ((report_document ->> 'status') = status)
);

CREATE INDEX IF NOT EXISTS overcore_preflight_revisions_report_idx
  ON overcore_preflight_revisions (report_id);

CREATE OR REPLACE FUNCTION overcore_reject_preflight_revision_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'overcore_preflight_revisions is append-only';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'overcore_preflight_revisions_immutable'
      AND tgrelid = 'overcore_preflight_revisions'::regclass
  ) THEN
    CREATE TRIGGER overcore_preflight_revisions_immutable
      BEFORE UPDATE ON overcore_preflight_revisions
      FOR EACH ROW
      EXECUTE FUNCTION overcore_reject_preflight_revision_update();
  END IF;
END;
$$;
