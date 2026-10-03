-- Private structured review output, not an agent-event or session transcript store.
CREATE TABLE review_run_artifacts (
  work_item_id uuid NOT NULL REFERENCES agent_work_items(id) ON DELETE CASCADE,
  logical_key text NOT NULL CHECK (octet_length(logical_key) BETWEEN 1 AND 256),
  artifact_order integer NOT NULL CHECK (artifact_order >= 0),
  kind text NOT NULL CHECK (kind IN (
    'brief', 'report', 'publication_prepared', 'publication_settled', 'final_summary'
  )),
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  envelope text NOT NULL CHECK (jsonb_typeof(envelope::jsonb) = 'object'),
  encoded_bytes integer GENERATED ALWAYS AS (octet_length(envelope)) STORED,
  reserved_bytes integer NOT NULL DEFAULT 0,
  prepared_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_item_id, logical_key),
  UNIQUE (work_item_id, artifact_order),
  FOREIGN KEY (work_item_id, prepared_key)
    REFERENCES review_run_artifacts(work_item_id, logical_key) ON DELETE CASCADE,
  CHECK (encoded_bytes + reserved_bytes <= 1048576),
  CHECK (
    (kind = 'publication_prepared' AND reserved_bytes IN (0, 8192))
    OR (kind <> 'publication_prepared' AND reserved_bytes = 0)
  ),
  CHECK ((kind = 'publication_settled') = (prepared_key IS NOT NULL))
);
