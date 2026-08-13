import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildVerificationWorkspaceTools } from "../src/agent/verification/verificationWorkspaceTools.js";
import { LOCAL_WORKSPACE_READ_RESPONSE_BYTES } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from "../src/util/jsonValue.js";

const exec = promisify(execFile);

function requireJsonObject(value: JsonValue | undefined): JsonObject {
  if (value === undefined || !isJsonObject(value)) {
    throw new Error("expected json object tool result");
  }
  return value;
}

function jsonString(value: JsonValue | undefined): string {
  if (!isJsonString(value)) {
    throw new Error("expected json string");
  }
  return value;
}

function jsonNumber(value: JsonValue | undefined): number {
  if (!isJsonNumber(value)) {
    throw new Error("expected json number");
  }
  return value;
}

describe("buildVerificationWorkspaceTools readWorkspaceFile", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup(files: Readonly<Record<string, string>>) {
    const root = await mkdtemp(join(tmpdir(), "verification-ws-tools-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const { executors } = buildVerificationWorkspaceTools({
      cfg: makeTestConfig(),
      rootDir: root,
    });
    return { root, executors };
  }

  it("names a FIFO instead of reporting it missing", async () => {
    const { root, executors } = await setup({ "src/app.ts": "export {};\n" });
    await mkdir(join(root, "logs"), { recursive: true });
    await exec("mkfifo", [join(root, "logs", "live.pipe")]);

    const out = requireJsonObject(await executors.readWorkspaceFile({ path: "logs/live.pipe" }));

    expect(out.refused).toBe(true);
    expect(jsonString(out.reason)).toContain("FIFO");
    expect(jsonString(out.reason)).not.toContain("missing");
  });

  it("notes an empty file instead of returning silent empty content", async () => {
    const { executors } = await setup({ "src/empty.ts": "" });

    const out = requireJsonObject(await executors.readWorkspaceFile({ path: "src/empty.ts" }));

    expect(out.content).toBe("");
    expect(out.note).toBe("File is empty (0 bytes).");
    expect(out.refused).toBeUndefined();
  });

  it("reads regular files without a note", async () => {
    const { executors } = await setup({ "src/app.ts": "alpha\nbeta\n" });

    const out = requireJsonObject(await executors.readWorkspaceFile({ path: "src/app.ts" }));

    expect(out.content).toBe("alpha\nbeta\n");
    expect(out.note).toBeUndefined();
  });

  it("refuses binary files with the shared named dead end", async () => {
    const { executors } = await setup({ "src/blob.bin": "abc\0def\n" });

    const out = requireJsonObject(await executors.readWorkspaceFile({ path: "src/blob.bin" }));

    expect(out.refused).toBe(true);
    expect(out.reason).toBe("Binary file cannot be read as text.");
  });

  it("caps oversized reads at the shared response budget with a resume offset", async () => {
    // Lines stay under the per-line clamp so the byte budget is what fires.
    const bigFile = ("x".repeat(1_000) + "\n").repeat(400);
    const { executors } = await setup({ "src/big.txt": bigFile });

    const out = requireJsonObject(await executors.readWorkspaceFile({ path: "src/big.txt" }));

    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe("response byte budget exceeded");
    expect(jsonNumber(out.returnedBytes)).toBeLessThanOrEqual(LOCAL_WORKSPACE_READ_RESPONSE_BYTES);
    // A byte-cap cut lands mid-line, so the next read resumes on that line.
    expect(jsonNumber(out.endLine)).toBeGreaterThan(1);
    expect(jsonNumber(out.resumeStartLine)).toBe(jsonNumber(out.endLine));
  });

  it("supports line-window reads like every other feature", async () => {
    const { executors } = await setup({ "src/app.ts": "a\nb\nc\nd\n" });

    const out = requireJsonObject(
      await executors.readWorkspaceFile({
        path: "src/app.ts",
        startLine: 2,
        maxLines: 2,
      }),
    );

    expect(out.content).toBe("b\nc");
    expect(out.startLine).toBe(2);
    expect(out.endLine).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.resumeStartLine).toBe(4);
    expect(out.note).toBe("Line window ended at line 3 of 4. Resume with startLine 4.");
  });

  it("strips BOM and normalizes CRLF so line numbers match diff and blame", async () => {
    const { executors } = await setup({ "src/crlf.ts": "\uFEFFone\r\ntwo\r\n" });

    const out = requireJsonObject(await executors.readWorkspaceFile({ path: "src/crlf.ts" }));

    expect(out.content).toBe("one\ntwo\n");
    expect(out.endLine).toBe(2);
  });
});
