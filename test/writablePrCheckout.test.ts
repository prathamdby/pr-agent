import { execFile as execFileCb } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/settings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/index.js")>();
  return { ...actual, LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS: 1 };
});
import { AppError } from "../src/errors/appError.js";
import {
  buildCommitCommandArgs,
  StaleHeadPushError,
  withWritablePrCheckout,
} from "../src/prWorkspace/writablePrCheckout.js";
import { cleanupStaleLocalPrWorkspaces } from "../src/prWorkspace/localPrWorkspace.js";

const execFile = promisify(execFileCb);
const TEST_TIMEOUT_MS = 20_000;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function makeRemote() {
  const root = await mkdtemp(join(tmpdir(), "writable-checkout-test-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  await git(root, ["init", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "src.txt"), "one\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  await git(root, ["init", "--bare", remote]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "origin", "HEAD:refs/heads/main"]);
  const headSha = await git(repo, ["rev-parse", "HEAD"]);
  return { root, repo, remote, headSha };
}

describe("writable PR checkout", () => {
  it(
    "commits one validated fix and pushes without force",
    async () => {
      const { root, remote, headSha } = await makeRemote();
      try {
        await withWritablePrCheckout(
          {
            owner: "owner",
            repo: "repo",
            headRef: "main",
            headSha,
            installationToken: "unused",
            botIdentity: { userId: 123, login: "pr-agent[bot]" },
            remoteUrlOverride: remote,
          },
          async (checkout) => {
            await writeFile(join(checkout.dir, "src.txt"), "one\ntwo\n");
            const result = await checkout.commit({
              files: ["src.txt"],
              subject: "fix: add missing line",
            });
            expect(result.diff).toContain("+two");
            expect(checkout.listCommittedShas()).toEqual([result.sha]);
            await checkout.push();
          },
        );

        const clone = join(root, "clone");
        await git(root, ["clone", "--branch", "main", remote, clone]);
        expect(await readFile(join(clone, "src.txt"), "utf8")).toContain("two");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it("rejects bad subjects, oversized bodies, and uses -n", () => {
    expect(() => buildCommitCommandArgs({ files: ["x"], subject: "fix(scope): nope" })).toThrow();
    expect(() =>
      buildCommitCommandArgs({
        files: ["x"],
        subject: "fix: guard null user",
        body: ["- One", "- Two", "- Three", "- Four", "- Five", "- Six"],
      }),
    ).toThrow(/at most 5 bullets/);
    expect(
      buildCommitCommandArgs({
        files: ["x"],
        subject: "fix: guard null user",
        body: ["- Cover null user path"],
      }),
    ).toEqual(["commit", "-n", "-m", "fix: guard null user", "-m", "- Cover null user path"]);
    expect(buildCommitCommandArgs({ files: ["x"], subject: "fix: guard null user" })).toContain(
      "-n",
    );
  });

  it(
    "surfaces non-fast-forward pushes as StaleHeadPushError",
    async () => {
      const { root, repo, remote, headSha } = await makeRemote();
      try {
        await expect(
          withWritablePrCheckout(
            {
              owner: "owner",
              repo: "repo",
              headRef: "main",
              headSha,
              installationToken: "unused",
              botIdentity: { userId: 123, login: "pr-agent[bot]" },
              remoteUrlOverride: remote,
            },
            async (checkout) => {
              await writeFile(join(repo, "other.txt"), "other\n");
              await git(repo, ["add", "."]);
              await git(repo, ["commit", "-m", "human"]);
              await git(repo, ["push", "origin", "HEAD:refs/heads/main"]);

              await writeFile(join(checkout.dir, "src.txt"), "one\ntwo\n");
              await checkout.commit({ files: ["src.txt"], subject: "fix: add missing line" });
              await checkout.push();
            },
          ),
        ).rejects.toSatisfy((error: unknown) => {
          expect(error).toBeInstanceOf(StaleHeadPushError);
          expect(error).toBeInstanceOf(AppError);
          expect((error as StaleHeadPushError).code).toBe("triage.stale_head_push");
          return true;
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it("rejects invalid headSha with pr_workspace.invalid_sha and field context", async () => {
    await expect(
      withWritablePrCheckout(
        {
          owner: "owner",
          repo: "repo",
          headRef: "main",
          headSha: "not-a-sha",
          installationToken: "unused",
          botIdentity: { userId: 123, login: "pr-agent[bot]" },
        },
        async () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("pr_workspace.invalid_sha");
      expect((error as AppError).context).toEqual({ field: "headSha" });
      return true;
    });
  });

  it(
    "rejects unsafe paths and resets index after oversized staged diff",
    async () => {
      const { root, remote, headSha } = await makeRemote();
      try {
        await withWritablePrCheckout(
          {
            owner: "owner",
            repo: "repo",
            headRef: "main",
            headSha,
            installationToken: "unused",
            botIdentity: { userId: 123, login: "pr-agent[bot]" },
            remoteUrlOverride: remote,
          },
          async (checkout) => {
            await expect(
              checkout.commit({ files: ["../escape"], subject: "fix: guard path" }),
            ).rejects.toThrow(/traversal/);
            await writeFile(join(checkout.dir, ".env"), "SECRET=1\n");
            await expect(
              checkout.commit({ files: [".env"], subject: "fix: guard path" }),
            ).rejects.toThrow(/sensitive/);

            await writeFile(
              join(checkout.dir, "src.txt"),
              Array.from({ length: 205 }, (_, index) => `line ${index}`).join("\n"),
            );
            await expect(
              checkout.commit({ files: ["src.txt"], subject: "fix: expand file" }),
            ).rejects.toThrow(/not minimal/);

            await writeFile(join(checkout.dir, "other.txt"), "small\n");
            const result = await checkout.commit({
              files: ["other.txt"],
              subject: "fix: add small file",
            });
            expect(result.diff).toContain("other.txt");
            expect(result.diff).not.toContain("line 204");
          },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it("removes stale triage checkout dirs with local workspace cleanup", async () => {
    const staleDir = await mkdtemp(join(tmpdir(), "pr-agent-triage-test-"));
    try {
      await mkdir(join(staleDir, "checkout"), { recursive: true });
      const old = new Date(Date.now() - 10_000);
      await utimes(staleDir, old, old);

      await cleanupStaleLocalPrWorkspaces();

      await expect(stat(staleDir)).rejects.toThrow();
    } finally {
      await rm(staleDir, { recursive: true, force: true });
    }
  });

  it(
    "strips attacker-controlled symlinks before exposing the checkout",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "writable-checkout-symlink-"));
      const repo = join(root, "repo");
      const remote = join(root, "remote.git");
      try {
        await git(root, ["init", repo]);
        await git(repo, ["config", "user.email", "test@example.com"]);
        await git(repo, ["config", "user.name", "Test"]);
        await writeFile(join(repo, "src.txt"), "one\n");
        await symlink("/etc/passwd", join(repo, "leak.md"));
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "base with symlink"]);
        await git(root, ["init", "--bare", remote]);
        await git(repo, ["remote", "add", "origin", remote]);
        await git(repo, ["push", "origin", "HEAD:refs/heads/main"]);
        const headSha = await git(repo, ["rev-parse", "HEAD"]);

        await withWritablePrCheckout(
          {
            owner: "owner",
            repo: "repo",
            headRef: "main",
            headSha,
            installationToken: "unused",
            botIdentity: { userId: 123, login: "pr-agent[bot]" },
            remoteUrlOverride: remote,
          },
          async (checkout) => {
            await expect(lstat(join(checkout.dir, "leak.md"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            expect(await readFile(join(checkout.dir, "src.txt"), "utf8")).toContain("one");
          },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
