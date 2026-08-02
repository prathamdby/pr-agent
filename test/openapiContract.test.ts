import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const OPENAPI_PATH = path.join(process.cwd(), "docs", "api", "openapi.yaml");

describe("openapi contract", () => {
  it("documents web service paths that match the route table", () => {
    const doc = parseYaml(fs.readFileSync(OPENAPI_PATH, "utf8")) as {
      paths?: Record<string, unknown>;
    };
    const paths = Object.keys(doc.paths ?? {}).sort();
    expect(paths).toEqual(["/health", "/ready", "/webhooks"].sort());
  });
});
