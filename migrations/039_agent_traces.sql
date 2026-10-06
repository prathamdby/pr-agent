CREATE TABLE agent_trace_spans (
  id uuid PRIMARY KEY,
  execution_id uuid NOT NULL,
  parent_id uuid,
  work_item_id uuid REFERENCES agent_work_items(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('execution', 'session', 'generation', 'tool', 'compaction')),
  role text,
  phase text,
  provider text,
  model text,
  specialist text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  ttft_ms double precision,
  reasoning_ms double precision,
  input bigint,
  output bigint,
  cache_read bigint,
  cache_write bigint,
  reasoning bigint,
  cost_usd double precision,
  cost_source text NOT NULL CHECK (cost_source IN ('provider', 'catalog', 'unknown')),
  status text NOT NULL CHECK (status IN ('ok', 'error', 'cancelled')),
  error_code text,
  attrs jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX agent_trace_execution_started_idx ON agent_trace_spans(execution_id, started_at);
CREATE INDEX agent_trace_work_item_idx ON agent_trace_spans(work_item_id);
CREATE INDEX agent_trace_model_kind_idx ON agent_trace_spans(model, kind);
CREATE INDEX agent_trace_started_brin_idx ON agent_trace_spans USING brin(started_at);

CREATE TABLE agent_trace_blobs (
  sha256 text PRIMARY KEY,
  body text NOT NULL,
  bytes integer NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_trace_blobs_seen_idx ON agent_trace_blobs(last_seen_at);
DO $$
BEGIN
  EXECUTE 'ALTER TABLE agent_trace_blobs ALTER COLUMN body SET COMPRESSION lz4';
EXCEPTION WHEN feature_not_supported OR invalid_parameter_value OR syntax_error THEN
  NULL;
END $$;

CREATE TABLE agent_trace_parts (
  span_id uuid NOT NULL REFERENCES agent_trace_spans(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  part_kind text NOT NULL CHECK (part_kind IN ('system', 'user', 'assistant_text', 'thinking', 'tool_args', 'tool_result')),
  blob_sha text NOT NULL REFERENCES agent_trace_blobs(sha256),
  redactions integer NOT NULL,
  PRIMARY KEY (span_id, seq)
);
CREATE INDEX agent_trace_parts_blob_idx ON agent_trace_parts(blob_sha);
