import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isTriageSearchPathAllowed } from "../src/agent/triage/triageWorkspaceTools.js";
import { buildVerificationWorkspaceTools } from "../src/agent/verification/verificationWorkspaceTools.js";
import { LOCAL_WORKSPACE_READ_RESPONSE_BYTES } from "../src/settings/index.js";
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

  it("refuses binary files with the shared named dead end", async () => {
    const { executors } = await setup({ "src/blob.bin": "abc\0def\n" });

    const out = (await executors.readWorkspaceFile({ path: "src/blob.bin" })) as {
      refused?: boolean;
      reason?: string;
    };

    expect(out.refused).toBe(true);
    expect(out.reason).toBe("Binary file cannot be read as text.");
  });

  it("caps oversized reads at the shared response budget with a resume offset", async () => {
    // Lines stay under the per-line clamp so the byte budget is what fires.
    const bigFile = ("x".repeat(1_000) + "\n").repeat(400);
    const { executors } = await setup({ "src/big.txt": bigFile });

    const out = (await executors.readWorkspaceFile({ path: "src/big.txt" })) as {
      truncated?: boolean;
      truncationReason?: string;
      resumeStartLine?: number;
      endLine?: number;
      returnedBytes?: number;
    };

    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe("response byte budget exceeded");
    expect(out.returnedBytes).toBeLessThanOrEqual(LOCAL_WORKSPACE_READ_RESPONSE_BYTES);
    // A byte-cap cut lands mid-line, so the next read resumes on that line.
    expect(out.endLine).toBeGreaterThan(1);
    expect(out.resumeStartLine).toBe(out.endLine);
  });

  it("supports line-window reads like every other feature", async () => {
    const { executors } = await setup({ "src/app.ts": "a\nb\nc\nd\n" });

    const out = (await executors.readWorkspaceFile({
      path: "src/app.ts",
      startLine: 2,
      maxLines: 2,
    })) as {
      content?: string;
      startLine?: number;
      endLine?: number;
      truncated?: boolean;
      resumeStartLine?: number;
      note?: string;
    };

    expect(out.content).toBe("b\nc");
    expect(out.startLine).toBe(2);
    expect(out.endLine).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.resumeStartLine).toBe(4);
    expect(out.note).toBe("Line window ended at line 3 of 4. Resume with startLine 4.");
  });

  it("strips BOM and normalizes CRLF so line numbers match diff and blame", async () => {
    const { executors } = await setup({ "src/crlf.ts": "\uFEFFone\r\ntwo\r\n" });

    const out = (await executors.readWorkspaceFile({ path: "src/crlf.ts" })) as {
      content?: string;
      endLine?: number;
    };

    expect(out.content).toBe("one\ntwo\n");
    expect(out.endLine).toBe(2);
  });
});

describe("buildVerificationWorkspaceTools searchWorkspace", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup(files: Readonly<Record<string, string>>) {
    const root = await mkdtemp(join(tmpdir(), "verification-ws-search-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await exec("git", ["init"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-m", "seed"], { cwd: root });
    const { executors } = buildVerificationWorkspaceTools({
      cfg: makeTestConfig(),
      rootDir: root,
    });
    return { root, executors };
  }

  it("returns empty matches when searchWorkspace finds nothing", async () => {
    const { executors } = await setup({ "src/app.ts": "const value = 1;\n" });
    const out = await executors.searchWorkspace({ query: "no-such-token-xyz" });
    expect(out).toEqual({ matches: [], truncated: false });
  });

  it("returns clean-path hits without a filtered marker", async () => {
    const { executors } = await setup({
      "src/safe-a.ts": "export const safeA = needle;\n",
      "src/safe-b.ts": "export const safeB = needle;\n",
    });

    const out = await executors.searchWorkspace({ query: "needle" });
    expect(out).toEqual({
      matches: [
        { path: "src/safe-a.ts", line: 1, text: "export const safeA = needle;" },
        { path: "src/safe-b.ts", line: 1, text: "export const safeB = needle;" },
      ],
      truncated: false,
    });
  });

  it("filters blocked paths before applying the result cap", async () => {
    const blockedText = "verify-private-value-540";
    const { executors } = await setup({
      ".env": `TOKEN=${blockedText} needle\n`,
      ".npmrc": `//registry.example/:_authToken=${blockedText} needle\n`,
      ".aws/credentials": `[default]\naws_secret_access_key=${blockedText} needle\n`,
      "certs/signing.pem": `-----BEGIN PRIVATE KEY----- ${blockedText} needle\n`,
      ".github/workflows/ci.yml": `name: ${blockedText} needle\n`,
      "src/safe-a.ts": "export const safeA = needle;\n",
      "src/safe-b.ts": "export const safeB = needle;\n",
      "src/safe-c.ts": "export const safeC = needle;\n",
    });

    const out = (await executors.searchWorkspace({ query: "needle", maxResults: 2 })) as {
      matches: Array<{ path: string; line: number; text: string }>;
      truncated: boolean;
      filtered?: boolean;
    };

    expect(out).toEqual({
      matches: [
        { path: "src/safe-a.ts", line: 1, text: "export const safeA = needle;" },
        { path: "src/safe-b.ts", line: 1, text: "export const safeB = needle;" },
      ],
      truncated: true,
      filtered: true,
    });
    expect(JSON.stringify(out)).not.toContain(blockedText);
    expect(JSON.stringify(out)).not.toContain(".env");
    expect(JSON.stringify(out)).not.toContain(".npmrc");
  });

  it("filters a symlink alias to a blocked target without exposing its text", async () => {
    const { root, executors } = await setup({
      ".env": "TOKEN=verify-private-value-540\n",
      "src/safe.ts": "export const safe = true;\n",
    });
    await mkdir(join(root, "docs"), { recursive: true });
    await symlink("../.env", join(root, "docs", "config.ts"));
    await exec("git", ["add", "docs/config.ts"], { cwd: root });
    await symlink("../.env.dangling", join(root, "docs", "broken.ts"));
    await exec("git", ["add", "docs/broken.ts"], { cwd: root });
    await exec("git", ["commit", "-m", "add symlink fixture"], { cwd: root });

    await expect(isTriageSearchPathAllowed(root, "docs/config.ts")).resolves.toBe(false);
    await expect(isTriageSearchPathAllowed(root, "././.env")).resolves.toBe(false);
    await expect(isTriageSearchPathAllowed(root, "src/safe.ts")).resolves.toBe(true);
    await expect(isTriageSearchPathAllowed(root, "././src/safe.ts")).resolves.toBe(true);
    await expect(isTriageSearchPathAllowed(root, "docs/broken.ts")).resolves.toBe(false);
    await expect(executors.searchWorkspace({ query: "../.env" })).resolves.toEqual({
      matches: [],
      truncated: false,
    });
    await expect(executors.searchWorkspace({ query: "../.env.dangling" })).resolves.toEqual({
      matches: [],
      truncated: false,
    });
  });

  it("withholds key-extension and control-path hits", async () => {
    const blockedText = "verify-private-value-540";
    const { executors } = await setup({
      "certs/server.key": `secret=${blockedText}\n`,
      "package.json": `{"name":"${blockedText}"}\n`,
      "src/key-utils.ts": "export const helper = true;\n",
    });

    const secretOut = (await executors.searchWorkspace({ query: blockedText })) as {
      matches: unknown[];
      filtered?: boolean;
    };
    expect(secretOut.matches).toEqual([]);
    expect(secretOut.filtered).toBe(true);
    expect(JSON.stringify(secretOut)).not.toContain(blockedText);

    const cleanOut = await executors.searchWorkspace({ query: "helper" });
    expect(cleanOut).toEqual({
      matches: [{ path: "src/key-utils.ts", line: 1, text: "export const helper = true;" }],
      truncated: false,
    });
  });
});
