import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";
import { ENV, EXTERNAL_ENV } from "../src/settings/index.js";
import { jsonValueSchema } from "../src/util/jsonValue.js";

const ENV_EXAMPLE_PATH = path.join(process.cwd(), ".env.example");
const NUB_JSONC_PATH = path.join(process.cwd(), "nub.jsonc");
const NUB_LOCK_PATH = path.join(process.cwd(), "nub.lock");
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
    expect(new Set(envValues).size).toBe(envValues.length);
    expect(envValues).toContain("PI_ORCHESTRATOR_PROVIDER");
    expect(envValues).toContain("PI_ORCHESTRATOR_MODEL");
    expect(envValues).toContain("PI_FALLBACK_PROVIDER");
    expect(envValues).toContain("PI_FALLBACK_MODEL");
    expect(envValues).toContain("PI_THINKING_CEILING");
    expect(envValues).toContain("AGENT_RESUME_SNAPSHOT_KEY");
    expect(envValues).toContain("AGENT_RESUME_SNAPSHOT_MARGIN_SECONDS");
    expect(envValues).toContain("AGENT_EVENTS_ENABLED");
    expect(envValues).toContain("AGENT_EVENTS_RETENTION_SECONDS");
    expect(envValues).toContain("FINDING_HISTORY_ENABLED");
    expect(envValues).toContain("FINDING_HISTORY_DISMISS_SUPPRESS_AFTER");
    expect(envValues).toContain("FINDING_HISTORY_LOOKBACK_DAYS");
    expect(envValues).toContain("CODE_INDEX_MODE");
    expect(envValues).toContain("CODE_INDEX_WAIT_MS");
    expect(envValues).toContain("CODE_INDEX_RETENTION_SECONDS");
    expect(envValues.length).toBe(61);
  });

  it("docs/features.md documents every FEATURE_* key", () => {
    const featuresDoc = fs.readFileSync(path.join(process.cwd(), "docs", "features.md"), "utf8");
    const featureKeys = Object.values(ENV).filter((key) => key.startsWith("FEATURE_"));
    expect(featureKeys.length).toBe(8);
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

  it("nub.jsonc keeps a 7d cooling window with string excludes", () => {
    const config = v.parse(
      v.object({
        install: v.optional(
          v.object({
            minimumReleaseAge: v.optional(v.string()),
            minimumReleaseAgeExclude: v.optional(v.array(v.string())),
          }),
        ),
      }),
      parseYaml(fs.readFileSync(NUB_JSONC_PATH, "utf8")),
    );
    expect(config.install?.minimumReleaseAge).toBe("7d");
    const excludes = config.install?.minimumReleaseAgeExclude;
    expect(Array.isArray(excludes)).toBe(true);
    if (!Array.isArray(excludes)) return;
    expect(excludes.length).toBeGreaterThan(0);
    for (const entry of excludes) {
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  it("nub.lock overrides and importers match package.json", () => {
    const pkg = v.parse(
      v.object({
        overrides: v.optional(v.record(v.string(), v.string())),
        workspaces: v.optional(v.array(v.string())),
      }),
      JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")),
    );
    const lock = v.parse(
      v.object({
        overrides: v.optional(v.record(v.string(), v.union([v.string(), v.number()]))),
        importers: v.optional(v.record(v.string(), jsonValueSchema)),
      }),
      parseYaml(fs.readFileSync(NUB_LOCK_PATH, "utf8")),
    );
    expect(pkg.overrides).toBeTruthy();
    expect(lock.overrides).toBeTruthy();
    const pkgOverrides = pkg.overrides!;
    const lockOverrides = Object.fromEntries(
      Object.entries(lock.overrides!).map(([key, value]) => [key, String(value)]),
    );
    expect(lockOverrides).toEqual(pkgOverrides);
    const workspaces = pkg.workspaces ?? [];
    expect(workspaces.length).toBeGreaterThan(0);
    for (const workspace of workspaces) {
      const importerKey = workspace === "." ? "." : workspace;
      expect(lock.importers?.[importerKey], `missing importer ${importerKey}`).toBeTruthy();
    }
  });
});
