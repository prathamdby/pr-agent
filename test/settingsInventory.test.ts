import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  DEFAULT_MAX_PR_FILES_LISTED,
  DEFAULT_MAX_PR_FILES_PATCH_BYTES,
  ENV,
  EXTERNAL_ENV,
} from "../src/settings/index.js";

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
    expect(new Set(envValues).size).toBe(envValues.length);
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

  it("high-risk defaults match settings/defaults.ts", () => {
    const content = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");
    const documented = parseEnvExampleKeys(content);
    const readExample = (key: string): string | undefined => {
      const line = content.split("\n").find((l) => l.trim().startsWith(`${key}=`));
      if (!line) return undefined;
      return line.split("=")[1]?.trim();
    };

    expect(readExample(ENV.MAX_PR_FILES_LISTED)).toBe(String(DEFAULT_MAX_PR_FILES_LISTED));
    expect(readExample(ENV.MAX_PR_FILES_PATCH_BYTES)).toBe(
      String(DEFAULT_MAX_PR_FILES_PATCH_BYTES),
    );
    expect(readExample(ENV.WEBHOOK_MAX_BODY_BYTES)).toBe(String(DEFAULT_WEBHOOK_MAX_BODY_BYTES));
    expect(documented.length).toBeGreaterThan(20);
  });

  it("PostHog keys are inventory-gated and the client module does not read process.env", () => {
    expect(Object.values(ENV)).toContain("POSTHOG_PROJECT_TOKEN");
    expect(Object.values(ENV)).toContain("POSTHOG_HOST");
    expect(Object.values(ENV)).toContain("POSTHOG_ENABLED");
    expect(Object.values(ENV)).toContain("POSTHOG_EXCEPTION_AUTOCAPTURE");

    const posthogSrc = fs.readFileSync(path.join(process.cwd(), "src/posthog.ts"), "utf8");
    expect(posthogSrc).not.toMatch(/process\.env/);

    const configSrc = fs.readFileSync(path.join(process.cwd(), "src/config.ts"), "utf8");
    expect(configSrc).toMatch(/ENV\.POSTHOG_PROJECT_TOKEN/);
    expect(configSrc).toMatch(/ENV\.POSTHOG_HOST/);
    expect(configSrc).toMatch(/ENV\.POSTHOG_ENABLED/);
    expect(configSrc).toMatch(/ENV\.POSTHOG_EXCEPTION_AUTOCAPTURE/);

    const configurationDocs = fs.readFileSync(
      path.join(process.cwd(), "docs/configuration.md"),
      "utf8",
    );
    expect(configurationDocs).toMatch(/POSTHOG_PROJECT_TOKEN/);
    expect(configurationDocs).toMatch(/POSTHOG_HOST/);
    expect(configurationDocs).toMatch(/POSTHOG_ENABLED/);
    expect(configurationDocs).toMatch(/POSTHOG_EXCEPTION_AUTOCAPTURE/);
  });
});
