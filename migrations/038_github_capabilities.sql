ALTER TABLE agent_work_items
  ADD COLUMN github_preflight_failure_count integer NOT NULL DEFAULT 0
  CHECK (github_preflight_failure_count >= 0);

CREATE SEQUENCE github_capability_observation_generation_seq;

CREATE TABLE github_repository_capabilities (
  installation_id bigint NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  generation bigint NOT NULL,
  capabilities jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, owner, repo)
);

CREATE TABLE github_head_ci_sources (
  installation_id bigint NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  head_sha text NOT NULL,
  source text NOT NULL CHECK (source IN ('checks', 'statuses')),
  generation bigint NOT NULL,
  access text NOT NULL CHECK (access IN ('available', 'denied', 'unknown')),
  listing_required boolean NOT NULL DEFAULT true,
  unknown_read_count integer NOT NULL DEFAULT 0 CHECK (unknown_read_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, owner, repo, head_sha, source),
  FOREIGN KEY (owner, repo, head_sha)
    REFERENCES pr_head_ci_state(owner, repo, head_sha) ON DELETE CASCADE
);

CREATE INDEX github_repository_capabilities_retention_idx
  ON github_repository_capabilities(observed_at);
CREATE INDEX github_head_ci_sources_retention_idx ON github_head_ci_sources(updated_at);
