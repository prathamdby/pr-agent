import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GATE_BASE = {
  CHANGES_RESULT: "success",
  CHECK_RESULT: "success",
  COMMIT_MESSAGES_RESULT: "success",
  INTEGRATION_RESULT: "skipped",
  DOCKER_RESULT: "skipped",
  SITE_RESULT: "skipped",
  BACKEND_SELECTED: "false",
  SITE_SELECTED: "false",
};

function gateExit(overrides: Partial<typeof GATE_BASE>): number {
  try {
    execFileSync("bash", ["scripts/ci-gate.sh"], {
      cwd: process.cwd(),
      env: { ...process.env, ...GATE_BASE, ...overrides },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return typeof status === "number" ? status : 1;
  }
}

describe("feature map", () => {
  it("matches the generator output (do not hand-edit docs/feature-map.md)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feature-map-"));
    const out = path.join(tmp, "feature-map.md");
    execFileSync(process.execPath, ["scripts/gen-feature-map.mjs", out], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    execFileSync(path.join(process.cwd(), "node_modules", ".bin", "oxfmt"), [out], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const expected = fs.readFileSync(path.join(process.cwd(), "docs", "feature-map.md"), "utf8");
    const actual = fs.readFileSync(out, "utf8");
    expect(actual).toBe(expected);
  });
});

describe("ci gate", () => {
  it.each(["skipped", "cancelled", "failure"] as const)(
    "rejects check=%s when no downstream job is selected",
    (check) => {
      expect(
        gateExit({
          CHECK_RESULT: check,
          BACKEND_SELECTED: "false",
          SITE_SELECTED: "false",
          INTEGRATION_RESULT: "skipped",
          DOCKER_RESULT: "skipped",
          SITE_RESULT: "skipped",
        }),
      ).toBe(1);
    },
  );

  it("accepts a successful check when unselected jobs are skipped", () => {
    expect(gateExit({})).toBe(0);
  });

  it.each(["integration", "docker", "site"] as const)(
    "require_selected covers %s for selected and unselected results",
    (job) => {
      const results = ["success", "skipped", "failure", "cancelled"] as const;
      for (const selected of ["true", "false"] as const) {
        for (const result of results) {
          const overrides: Partial<typeof GATE_BASE> = {
            BACKEND_SELECTED: job === "site" ? "false" : selected,
            SITE_SELECTED: job === "site" ? selected : "false",
            INTEGRATION_RESULT: job === "integration" ? result : "success",
            DOCKER_RESULT: job === "docker" ? result : "success",
            SITE_RESULT: job === "site" ? result : "skipped",
          };
          const expected =
            selected === "true"
              ? result === "success"
                ? 0
                : 1
              : result === "success" || result === "skipped"
                ? 0
                : 1;
          expect(gateExit(overrides), `${job} selected=${selected} result=${result}`).toBe(
            expected,
          );
        }
      }
    },
  );
});
