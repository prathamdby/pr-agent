import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildVerificationWorkspaceTools } from "../src/agent/verification/verificationWorkspaceTools.js";
import { makeTestConfig } from "./helpers/config.js";

const exec = promisify(execFile);

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

    const out = (await executors.readWorkspaceFile({ path: "logs/live.pipe" })) as {
      refused?: boolean;
      reason?: string;
    };

    expect(out.refused).toBe(true);
    expect(out.reason).toContain("FIFO");
    expect(out.reason).not.toContain("missing");
  });

  it("notes an empty file instead of returning silent empty content", async () => {
    const { executors } = await setup({ "src/empty.ts": "" });

    const out = (await executors.readWorkspaceFile({ path: "src/empty.ts" })) as {
      content?: string;
      note?: string;
      refused?: boolean;
    };

    expect(out.content).toBe("");
    expect(out.note).toBe("File is empty (0 bytes).");
    expect(out.refused).toBeUndefined();
  });

  it("reads regular files without a note", async () => {
    const { executors } = await setup({ "src/app.ts": "alpha\nbeta\n" });

    const out = (await executors.readWorkspaceFile({ path: "src/app.ts" })) as {
      content?: string;
      note?: string;
    };

    expect(out.content).toBe("alpha\nbeta\n");
    expect(out.note).toBeUndefined();
  });
});
