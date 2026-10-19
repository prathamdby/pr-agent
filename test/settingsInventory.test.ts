import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { ENV, EXTERNAL_ENV } from "../src/settings/index.ts";

const ENV_EXAMPLE_PATH = path.join(process.cwd(), ".env.example");
const LOCK_PATH = path.join(process.cwd(), "package-lock.json");
const PACKAGE_JSON_PATH = path.join(process.cwd(), "package.json");

function parseEnvExampleKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    keys.push(trimmed.slice(0, eq).trim());
  }
  return keys;
}

describe("settings inventory", () => {
  it("ENV keys match loadConfig surface", () => {
    const envValues = Object.values(ENV);
    expect(envValues).toContain("PORT");
    expect(envValues).toContain("DATABASE_URL");
    expect(envValues).toContain("POSTHOG_PROJECT_TOKEN");
    expect(envValues).toContain("POSTHOG_HOST");
    expect(envValues).toContain("REVIEW_SPECIALIST_TIMEOUT_MS");
    expect(envValues).toContain("REVIEW_RECOVERY_ENABLED");
    expect(new Set(envValues).size).toBe(envValues.length);
    expect(envValues).toContain("PI_ORCHESTRATOR_PROVIDER");
    expect(envValues).toContain("PI_ORCHESTRATOR_MODEL");
    expect(envValues).toContain("PI_FALLBACK_PROVIDER");
    expect(envValues).toContain("PI_FALLBACK_MODEL");
    expect(envValues).toContain("PI_THINKING_CEILING");
    expect(envValues).toContain("PI_PROVIDER_RETRY_MAX");
    expect(envValues).toContain("PI_PROVIDER_MAX_RETRY_DELAY_MS");
    expect(envValues).toContain("AGENT_EVENTS_ENABLED");
    expect(envValues).toContain("AGENT_EVENTS_RETENTION_SECONDS");
    expect(envValues).not.toContain("CODE_INDEX_MODE");
    expect(envValues).not.toContain("FINDING_HISTORY_ENABLED");
    expect(envValues).not.toContain("FINDING_HISTORY_DISMISS_SUPPRESS_AFTER");
    expect(envValues).not.toContain("FINDING_HISTORY_LOOKBACK_DAYS");
    expect(envValues).not.toContain("TRACES_MODE");
    expect(envValues).not.toContain("TRACES_RETENTION_SECONDS");
    expect(envValues).not.toContain("TRACES_BUFFER_MAX_SPANS");
    expect(envValues.length).toBe(72);
  });

  it("docs/features.md documents every FEATURE_* key", () => {
    const featuresDoc = fs.readFileSync(path.join(process.cwd(), "docs", "features.md"), "utf8");
    const featureKeys = Object.values(ENV).filter((key) => key.startsWith("FEATURE_"));
    expect(featureKeys.length).toBe(9);
    for (const key of featureKeys) {
      expect(featuresDoc.includes(key), `missing ${key} in docs/features.md`).toBe(true);
    }
  });

  it(".env.example documents every loadConfig env key", () => {
    const content = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");
    const documented = parseEnvExampleKeys(content);
    const documentedSet = new Set(documented);
    const cataloguedKeys: ReadonlySet<string> = new Set([
      ...Object.values(ENV),
      ...Object.values(EXTERNAL_ENV),
    ]);

    for (const key of Object.values(ENV)) {
      expect(documentedSet.has(key), `missing ${key} in .env.example`).toBe(true);
    }

    for (const key of documented) {
      expect(cataloguedKeys.has(key), `${key} in .env.example is not catalogued`).toBe(true);
    }
  });

  it("npm applies the shared install policy from both workspace directories", () => {
    const cli = process.env.npm_execpath;
    expect(cli).toBeTruthy();
    if (!cli) throw new Error("Run the suite through npm run test");
    const config = JSON.parse(
      execFileSync(process.execPath, [cli, "config", "list", "--json"], {
        encoding: "utf8",
      }),
    );
    expect(config["min-release-age"]).toBe(7);
    expect(config["min-release-age-exclude"]).toEqual([]);
    expect(config["legacy-peer-deps"]).toBe(true);
    expect(config["ignore-scripts"]).toBe(true);
    expect(config["engine-strict"]).toBe(true);
    const environment = execFileSync(process.execPath, [cli, "run", "env"], {
      cwd: path.join(process.cwd(), "site"),
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) =>
        /^(npm_config_local_prefix|npm_config_ignore_scripts|npm_config_legacy_peer_deps|npm_config_engine_strict)=/.test(
          line,
        ),
      )
      .toSorted();
    expect(environment).toEqual(
      [
        `npm_config_local_prefix=${process.cwd()}`,
        "npm_config_ignore_scripts=true",
        "npm_config_legacy_peer_deps=true",
        "npm_config_engine_strict=true",
      ].toSorted(),
    );
  });

  it("the root lock includes each workspace and its declared dependencies", () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
      workspaces?: string[];
    };
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    const workspaces = pkg.workspaces ?? [];
    expect(workspaces.length).toBeGreaterThan(0);
    for (const workspace of ["", ...workspaces]) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), workspace, "package.json"), "utf8"),
      );
      expect(lock.packages[workspace]?.dependencies).toEqual(manifest.dependencies);
      expect(lock.packages[workspace]?.devDependencies).toEqual(manifest.devDependencies);
    }
  });
});
