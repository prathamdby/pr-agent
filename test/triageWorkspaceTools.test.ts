import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTriageWorkspaceTools,
  createTriageWorkspaceToolState,
  isTriageSearchPathAllowed,
} from "../src/agent/triage/triageWorkspaceTools.js";
import type { WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";
import {
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  MAX_TRIAGE_FIXES_PER_RUN,
} from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";

const exec = promisify(execFile);

function findingThread(overrides: Partial<BotFindingThread> = {}): BotFindingThread {
  return {
    rootCommentId: 101,
    lens: "review",
    path: "src/app.ts",
    line: 1,
    severity: "P1",
    titleSnippet: "P1 · bug",
    humanReplies: [],
    threadUrl: "https://example.test/thread/101",
    ...overrides,
  };
}

function mockCheckout(dir: string, commitImpl?: WritablePrCheckout["commit"]): WritablePrCheckout {
  return {
    dir,
    headRef: "feature",
    baseSha: "a".repeat(40),
    commit:
      commitImpl ??
      (async ({ files, subject }) => ({
        sha: "b".repeat(40),
        diff: `diff for ${files.join(",")} (${subject})`,
      })),
    push: async () => {},
    listCommittedShas: () => [],
    listCommittedDetails: () => [],
  };
}

async function initCheckout(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "triage-ws-tools-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await exec("git", ["init"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "seed"], { cwd: root });
  return root;
}

describe("buildTriageWorkspaceTools", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup(params?: {
    files?: Readonly<Record<string, string>>;
    inventory?: readonly BotFindingThread[];
    commit?: WritablePrCheckout["commit"];
  }) {
    const root = await initCheckout(
      params?.files ?? {
        "src/app.ts": "const value = 1;\n",
        "package.json": '{"name":"app"}\n',
      },
    );
    roots.push(root);
    const inventory = params?.inventory ?? [findingThread()];
    const state = createTriageWorkspaceToolState();
    const { executors } = buildTriageWorkspaceTools({
      cfg: makeTestConfig(),
      checkout: mockCheckout(root, params?.commit),
      inventory,
      state,
    });
    return { root, executors, state, inventory };
  }

  it("blocks read of control-plane paths", async () => {
    const { executors } = await setup();
    await expect(executors.readWorkspaceFile({ path: "package.json" })).rejects.toMatchObject({
      code: "triage.sensitive_path_blocked",
    });
  });

  it("names a FIFO instead of reporting it missing", async () => {
    const { root, executors } = await setup({ files: { "src/app.ts": "export {};\n" } });
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
    const { executors } = await setup({ files: { "src/empty.ts": "" } });

    const out = (await executors.readWorkspaceFile({ path: "src/empty.ts" })) as {
      content?: string;
      note?: string;
      refused?: boolean;
    };

    expect(out.content).toBe("");
    expect(out.note).toBe("File is empty (0 bytes).");
    expect(out.refused).toBeUndefined();
  });

  it("refuses binary files with the shared named dead end", async () => {
    const { executors } = await setup({ files: { "src/app.ts": "abc\0def\n" } });

    const out = (await executors.readWorkspaceFile({ path: "src/app.ts" })) as {
      refused?: boolean;
      reason?: string;
    };

    expect(out.refused).toBe(true);
    expect(out.reason).toBe("Binary file cannot be read as text.");
  });

  it("caps oversized reads at the shared response budget with a resume offset", async () => {
    // Lines stay under the per-line clamp so the byte budget is what fires.
    const bigFile = ("x".repeat(1_000) + "\n").repeat(400);
    const { executors } = await setup({ files: { "src/app.ts": bigFile } });

    const out = (await executors.readWorkspaceFile({ path: "src/app.ts" })) as {
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
    const { executors } = await setup({ files: { "src/app.ts": "a\nb\nc\nd\n" } });

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
    const { executors } = await setup({ files: { "src/app.ts": "\uFEFFone\r\ntwo\r\n" } });

    const out = (await executors.readWorkspaceFile({ path: "src/app.ts" })) as {
      content?: string;
      endLine?: number;
    };

    expect(out.content).toBe("one\ntwo\n");
    expect(out.endLine).toBe(2);
  });

  it("blocks read through absolute symlink escapes", async () => {
    const outside = await mkdtemp(join(tmpdir(), "triage-ws-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.env"), "TOKEN=leak\n");
    const root = await initCheckout({ "src/app.ts": "export {};\n" });
    roots.push(root);
    await mkdir(join(root, "docs"), { recursive: true });
    await symlink(join(outside, "secret.env"), join(root, "docs/notes.md"));

    const { executors } = buildTriageWorkspaceTools({
      cfg: makeTestConfig(),
      checkout: mockCheckout(root),
      inventory: [findingThread()],
      state: createTriageWorkspaceToolState(),
    });

    await expect(executors.readWorkspaceFile({ path: "docs/notes.md" })).rejects.toMatchObject({
      code: "pr_workspace.symlink_escape",
    });
  });

  it("returns empty matches when searchWorkspace finds nothing", async () => {
    const { executors } = await setup();
    const out = await executors.searchWorkspace({ query: "no-such-token-xyz" });
    expect(out).toEqual({ matches: [], truncated: false });
  });

  it("filters blocked paths before applying the result cap", async () => {
    const blockedText = "triage-private-value-475";
    const { executors } = await setup({
      files: {
        ".env": `TOKEN=${blockedText} needle\n`,
        ".npmrc": `//registry.example/:_authToken=${blockedText} needle\n`,
        ".aws/credentials": `[default]\naws_secret_access_key=${blockedText} needle\n`,
        "certs/signing.pem": `-----BEGIN PRIVATE KEY----- ${blockedText} needle\n`,
        ".github/workflows/ci.yml": `name: ${blockedText} needle\n`,
        "src/safe-a.ts": "export const safeA = needle;\n",
        "src/safe-b.ts": "export const safeB = needle;\n",
        "src/safe-c.ts": "export const safeC = needle;\n",
      },
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
      files: {
        ".env": "TOKEN=triage-private-value-475\n",
        "src/safe.ts": "export const safe = true;\n",
      },
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

  it("returns a unified diff for an edited workspace path", async () => {
    const { executors } = await setup();
    await executors.editWorkspaceFile({
      path: "src/app.ts",
      oldText: "const value = 1;",
      newText: "const value = 2;",
    });
    const out = await executors.getWorkspaceDiff({ path: "src/app.ts" });
    expect(out).toMatchObject({
      path: "src/app.ts",
      diff: expect.stringContaining("const value = 2;"),
    });
  });

  it("blocks edit through a symlink escaping the checkout", async () => {
    const outside = await mkdtemp(join(tmpdir(), "triage-ws-outside-edit-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.env"), "TOKEN=leak\n");
    const root = await initCheckout({ "src/app.ts": "export {};\n" });
    roots.push(root);
    await mkdir(join(root, "docs"), { recursive: true });
    await symlink(join(outside, "secret.env"), join(root, "docs/notes.md"));

    const { executors } = buildTriageWorkspaceTools({
      cfg: makeTestConfig(),
      checkout: mockCheckout(root),
      inventory: [findingThread({ path: "docs/notes.md" })],
      state: createTriageWorkspaceToolState(),
    });

    await expect(
      executors.editWorkspaceFile({
        path: "docs/notes.md",
        oldText: "TOKEN=leak",
        newText: "x",
      }),
    ).rejects.toMatchObject({ code: "triage.symlink_escape_blocked" });
  });

  it("rejects edit of files not in the finding inventory", async () => {
    const { executors } = await setup({
      files: {
        "src/app.ts": "const value = 1;\n",
        "src/util.ts": "export const util = 1;\n",
        "package.json": '{"name":"app"}\n',
      },
    });
    await expect(
      executors.editWorkspaceFile({
        path: "src/util.ts",
        oldText: "1",
        newText: "2",
      }),
    ).rejects.toMatchObject({ code: "triage.path_not_implicated" });
  });

  it("blocks edit of control-plane paths even when implicated", async () => {
    const { executors } = await setup({
      inventory: [findingThread({ path: "package.json" })],
    });
    await expect(
      executors.editWorkspaceFile({
        path: "package.json",
        oldText: '{"name":"app"}',
        newText: '{"name":"evil"}',
      }),
    ).rejects.toMatchObject({ code: "triage.control_path_blocked" });
  });

  it("rejects edit when oldText is missing", async () => {
    const { executors } = await setup();
    await expect(
      executors.editWorkspaceFile({
        path: "src/app.ts",
        oldText: "does-not-exist",
        newText: "x",
      }),
    ).rejects.toMatchObject({ code: "triage.old_text_not_found" });
  });

  it("rejects edit when oldText matches more than once", async () => {
    const { executors } = await setup({
      files: {
        "src/app.ts": "const x = 1;\nconst y = 1;\n",
        "package.json": "{}\n",
      },
    });
    await expect(
      executors.editWorkspaceFile({
        path: "src/app.ts",
        oldText: "1",
        newText: "2",
      }),
    ).rejects.toMatchObject({ code: "triage.old_text_ambiguous" });
  });

  it("edits an implicated file when oldText is unique", async () => {
    const { root, executors } = await setup();
    const out = await executors.editWorkspaceFile({
      path: "src/app.ts",
      oldText: "const value = 1;",
      newText: "const value = 2;",
    });
    expect(out).toEqual({ ok: true, path: "src/app.ts" });
    expect(await readFile(join(root, "src/app.ts"), "utf8")).toBe("const value = 2;\n");
  });

  it("edits a CRLF file with the normalized text the model saw, preserving CRLF", async () => {
    const { root, executors } = await setup({
      files: { "src/app.ts": "const value = 1;\r\nconst other = 3;\r\n" },
    });
    const out = await executors.editWorkspaceFile({
      path: "src/app.ts",
      oldText: "const value = 1;\nconst other = 3;",
      newText: "const value = 2;\nconst other = 3;",
    });
    expect(out).toEqual({ ok: true, path: "src/app.ts" });
    expect(await readFile(join(root, "src/app.ts"), "utf8")).toBe(
      "const value = 2;\r\nconst other = 3;\r\n",
    );
  });

  it("keeps LF-only lines in a mixed-ending file untouched by the edit", async () => {
    const { root, executors } = await setup({
      files: { "src/app.ts": "alpha\r\nbeta\ngamma\r\n" },
    });
    // oldText spans a line break, so it only matches in the normalized space
    // the model was shown — the raw fast path cannot serve this edit.
    const out = await executors.editWorkspaceFile({
      path: "src/app.ts",
      oldText: "alpha\nbeta",
      newText: "alpha\nBETA",
    });
    expect(out).toEqual({ ok: true, path: "src/app.ts" });
    expect(await readFile(join(root, "src/app.ts"), "utf8")).toBe("alpha\r\nBETA\ngamma\r\n");
  });

  it("does not double the carriage return when newText already uses CRLF", async () => {
    const { root, executors } = await setup({
      files: { "src/app.ts": "alpha\r\nbeta\r\ngamma\r\n" },
    });
    const out = await executors.editWorkspaceFile({
      path: "src/app.ts",
      oldText: "alpha\nbeta",
      newText: "alpha\r\none\r\ntwo",
    });
    expect(out).toEqual({ ok: true, path: "src/app.ts" });
    const written = await readFile(join(root, "src/app.ts"), "utf8");
    expect(written).toBe("alpha\r\none\r\ntwo\r\ngamma\r\n");
    expect(written).not.toContain("\r\r\n");
  });

  it("edits a BOM file with the normalized text the model saw, preserving the BOM", async () => {
    const { root, executors } = await setup({
      files: { "src/app.ts": "\uFEFFconst value = 1;\n" },
    });
    const out = await executors.editWorkspaceFile({
      path: "src/app.ts",
      oldText: "const value = 1;",
      newText: "const value = 2;",
    });
    expect(out).toEqual({ ok: true, path: "src/app.ts" });
    expect(await readFile(join(root, "src/app.ts"), "utf8")).toBe("\uFEFFconst value = 2;\n");
  });

  it("blocks create of control-plane workflow files", async () => {
    const { executors } = await setup();
    await expect(
      executors.createWorkspaceFile({
        path: ".github/workflows/evil.yml",
        content: "name: evil\n",
      }),
    ).rejects.toMatchObject({ code: "triage.control_path_blocked" });
  });

  it("rejects create of non-safe, non-control new files", async () => {
    const { executors } = await setup();
    await expect(
      executors.createWorkspaceFile({
        path: "src/helper.ts",
        content: "export {};\n",
      }),
    ).rejects.toMatchObject({ code: "triage.unsafe_new_file_blocked" });
  });

  it("creates a safe new file and rejects a duplicate create", async () => {
    const { root, executors } = await setup();
    const out = await executors.createWorkspaceFile({
      path: "docs/notes.md",
      content: "# n\n",
    });
    expect(out).toEqual({ ok: true, path: "docs/notes.md" });
    expect(await readFile(join(root, "docs/notes.md"), "utf8")).toBe("# n\n");

    await expect(
      executors.createWorkspaceFile({
        path: "docs/notes.md",
        content: "x",
      }),
    ).rejects.toMatchObject({ code: "triage.path_exists" });
  });

  it("rejects commitFix for an unknown inventory thread", async () => {
    const { executors } = await setup();
    await expect(
      executors.commitFix({
        threadRootCommentId: 999,
        files: ["src/app.ts"],
        subject: "fix: unknown thread",
      }),
    ).rejects.toMatchObject({ code: "triage.unknown_thread" });
  });

  it("rejects commitFix staging files not in the finding inventory", async () => {
    const commit = vi.fn(async () => ({ sha: "c".repeat(40), diff: "d" }));
    const { executors } = await setup({
      files: {
        "src/app.ts": "const value = 1;\n",
        "src/util.ts": "export const util = 1;\n",
        "package.json": '{"name":"app"}\n',
      },
      commit,
    });
    await expect(
      executors.commitFix({
        threadRootCommentId: 101,
        files: ["src/util.ts"],
        subject: "fix: un-implicated",
      }),
    ).rejects.toMatchObject({ code: "triage.path_not_implicated" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects duplicate commitFix for the same thread", async () => {
    const commit = vi.fn(async () => ({ sha: "c".repeat(40), diff: "d" }));
    const { executors, state } = await setup({ commit });
    await executors.commitFix({
      threadRootCommentId: 101,
      files: ["src/app.ts"],
      subject: "fix: once",
    });
    expect(state.commitByThreadRootCommentId.get(101)).toBe("c".repeat(40));

    await expect(
      executors.commitFix({
        threadRootCommentId: 101,
        files: ["src/app.ts"],
        subject: "fix: twice",
      }),
    ).rejects.toMatchObject({ code: "triage.commit_fix_duplicate" });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("rejects commitFix after the per-run fix budget is exhausted", async () => {
    const commit = vi.fn(async () => ({ sha: "d".repeat(40), diff: "d" }));
    const inventory = Array.from({ length: MAX_TRIAGE_FIXES_PER_RUN + 1 }, (_, i) =>
      findingThread({ rootCommentId: i + 1, path: "src/app.ts" }),
    );
    const { executors, state } = await setup({ inventory, commit });
    for (let i = 1; i <= MAX_TRIAGE_FIXES_PER_RUN; i++) {
      state.commitByThreadRootCommentId.set(i, "e".repeat(40));
    }

    await expect(
      executors.commitFix({
        threadRootCommentId: MAX_TRIAGE_FIXES_PER_RUN + 1,
        files: ["src/app.ts"],
        subject: "fix: over budget",
      }),
    ).rejects.toMatchObject({ code: "triage.fix_budget_reached" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("commitFix returns checkout sha and records the thread mapping", async () => {
    const commit = vi.fn(async ({ files, subject }) => ({
      sha: "f".repeat(40),
      diff: `files=${files.join("|")} subject=${subject}`,
    }));
    const { executors, state } = await setup({ commit });
    const out = await executors.commitFix({
      threadRootCommentId: 101,
      files: ["src/app.ts"],
      subject: "fix: app value",
      body: ["unique oldText match"],
    });
    expect(out).toEqual({
      sha: "f".repeat(40),
      diff: "files=src/app.ts subject=fix: app value",
    });
    expect(state.commitByThreadRootCommentId.get(101)).toBe("f".repeat(40));
    expect(commit).toHaveBeenCalledWith({
      files: ["src/app.ts"],
      subject: "fix: app value",
      body: ["unique oldText match"],
    });
  });
});
