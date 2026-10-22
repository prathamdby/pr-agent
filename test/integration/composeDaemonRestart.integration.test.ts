import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const project = "pr-agent-daemon-restart";
const composeFile = path.join(root, "docker-compose.yml");

function compose(args: readonly string[]): string {
  return execFileSync("docker", ["compose", "-p", project, "-f", composeFile, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PR_AGENT_ENV_FILE: path.join(root, "dev/mock.env"),
    },
  });
}

function postgresRestartPolicy(): string {
  const id = compose(["ps", "-q", "postgres"]).trim();
  if (id.length === 0) throw new Error("postgres container was not created");
  return execFileSync("docker", ["inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", id], {
    encoding: "utf8",
  }).trim();
}

describe("operator compose daemon restart", () => {
  beforeAll(() => {
    compose(["up", "-d", "--no-build", "postgres"]);
  }, 60_000);

  afterAll(() => {
    compose(["down", "-v", "--remove-orphans"]);
  });

  it("returns Postgres after the Docker daemon restarts", () => {
    expect(postgresRestartPolicy()).toBe("unless-stopped");
  });
});
