import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV, EXTERNAL_ENV } from "../src/settings/index.js";

const ENV_EXAMPLE_PATH = path.join(process.cwd(), ".env.example");

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
    expect(envValues.length).toBe(53);
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
});
