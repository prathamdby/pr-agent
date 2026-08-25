-- Cross-replica GitHub rate-limit circuit state (MVP).
-- Scoped to installation_id + open_until + last_error_kind only.
CREATE TABLE IF NOT EXISTS github_installation_rate_limit_circuits (
  installation_id bigint PRIMARY KEY,
  open_until timestamptz NOT NULL,
  last_error_kind text NOT NULL
);

CREATE INDEX IF NOT EXISTS github_installation_rate_limit_circuits_open_until_idx
  ON github_installation_rate_limit_circuits (open_until);
