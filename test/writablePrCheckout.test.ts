import { execFile as execFileCb } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const credentialHooks = { failAfterWrite: false };
const allocatedWorkspaceRoots: string[] = [];
vi.mock("../src/prWorkspace/gitCredentials.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/prWorkspace/gitCredentials.ts")>();
  return {
    ...actual,
    async createGitCredentialFiles(rootDir: string, token: string) {
      allocatedWorkspaceRoots.push(rootDir);
      const created = await actual.createGitCredentialFiles(rootDir, token);
      if (credentialHooks.failAfterWrite) {
        throw new Error("injected credential setup failure");
      }
      return created;
    },
  };
});
import { AppError } from "../src/errors/appError.ts";
import {
  buildCommitCommandArgs,
  gitIdentityEnv,
  StaleHeadPushError,
  withWritablePrCheckout,
} from "../src/prWorkspace/writablePrCheckout.ts";
import {
  buildTriageCommitAttribution,
  formatCoAuthoredByTrailer,
  gitPersonFromGithubUser,
  githubNoreplyEmail,
} from "../src/agent/triage/commitAttribution.ts";
import { spillTextToSessionFile } from "../src/agent/tools/readWorkspaceTextFile.ts";
import { replayPreviewHunks } from "../src/agent/triage/previewApproval.ts";
import { cleanupStaleLocalPrWorkspaces } from "../src/prWorkspace/localPrWorkspace.ts";

const execFile = promisify(execFileCb);
async function git(cwd: string, args: readonly string[]) {
  const { stdout } = await execFile("git", args, { cwd });
  return ((pinnedReturn: string | Promise<string>) => pinnedReturn)(stdout.trim());
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

async function objectStoreAllocatedBytes(objectsDir: string) {
  const entries = await readdir(objectsDir, { withFileTypes: true }).catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  });
  if (entries == null) return 0;
  let total = 0;
  for (const entry of entries) {
    const full = join(objectsDir, entry.name);
    if (entry.isDirectory()) {
      total += await objectStoreAllocatedBytes(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await lstat(full).catch(() => null);
    if (info != null) total += info.blocks > 0 ? info.blocks * 512 : info.size;
  }
  return total;
}

function watchWorkspaceObjectStores() {
  let highWater = 0;
  let stopped = false;
  const loop = (async () => {
    while (true) {
      if (stopped) break;
      for (const rootDir of allocatedWorkspaceRoots) {
        const bytes = await objectStoreAllocatedBytes(
          join(rootDir, "checkout", ".git", "objects"),
        ).catch(() => 0);
        highWater = Math.max(highWater, bytes);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  })();
  return {
    highWater: () => highWater,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

afterEach(() => {
  credentialHooks.failAfterWrite = false;
  allocatedWorkspaceRoots.length = 0;
});

describe("writable PR checkout", () => {
  it("commits one validated fix and pushes without force", async () => {
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
      const author = await git(clone, ["log", "-1", "--format=%an <%ae>"]);
      const committer = await git(clone, ["log", "-1", "--format=%cn <%ce>"]);
      const message = await git(clone, ["log", "-1", "--format=%B"]);
      expect(author).toBe("pr-agent[bot] <123+pr-agent[bot]@users.noreply.github.com>");
      expect(committer).toBe("pr-agent[bot] <123+pr-agent[bot]@users.noreply.github.com>");
      expect(message).not.toContain("Co-authored-by:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates oversized fetches at the byte ceiling and removes the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "writable-checkout-fetch-cap-"));
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    try {
      await git(root, ["init", repo]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test"]);
      await writeFile(join(repo, "src.txt"), "one\n");
      await writeFile(join(repo, "huge.bin"), randomBytes(24 * 1024 * 1024));
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "oversized head"]);
      await git(root, ["init", "--bare", remote]);
      await git(repo, ["remote", "add", "origin", remote]);
      await git(repo, ["push", "origin", "HEAD:refs/heads/main"]);
      const headSha = await git(repo, ["rev-parse", "HEAD"]);

      const watcher = watchWorkspaceObjectStores();
      let error: unknown;
      try {
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
              maxFetchBytes: 1024 * 1024,
            },
            async () => undefined,
          );
          throw new Error("expected rejection");
        } catch (caught) {
          error = caught;
        }
      } finally {
        await watcher.stop();
      }

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("pr_workspace.fetch_too_large");
      expect(watcher.highWater()).toBeGreaterThan(0);
      expect(watcher.highWater()).toBeLessThan(8 * 1024 * 1024);
      expect(watcher.highWater()).toBeLessThan(12 * 1024 * 1024);
      expect(allocatedWorkspaceRoots).not.toEqual([]);
      await Promise.all(
        allocatedWorkspaceRoots.map((rootDir) =>
          expect(stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs final commit and push guards at the writable side-effect boundaries", async () => {
    const { root, remote, headSha } = await makeRemote();
    const calls: string[] = [];
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
          beforeCommit: async () => {
            calls.push("before-commit");
          },
          beforePush: async () => {
            calls.push("before-push");
          },
        },
        async (checkout) => {
          await writeFile(join(checkout.dir, "src.txt"), "one\ntwo\n");
          await checkout.commit({ files: ["src.txt"], subject: "fix: add missing line" });
          await checkout.push();
        },
      );

      expect(calls).toEqual(["before-commit", "before-push"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attributes human triggerer as author/committer with App Co-authored-by", async () => {
    const { root, remote, headSha } = await makeRemote();
    const botIdentity = { userId: 123, login: "pr-agent[bot]" };
    const human = { name: "Alice", email: githubNoreplyEmail(42, "alice") };
    try {
      await withWritablePrCheckout(
        {
          owner: "owner",
          repo: "repo",
          headRef: "main",
          headSha,
          installationToken: "unused",
          botIdentity,
          commitAttribution: buildTriageCommitAttribution({
            botIdentity,
            triggerer: human,
          }),
          remoteUrlOverride: remote,
        },
        async (checkout) => {
          await writeFile(join(checkout.dir, "src.txt"), "one\ntwo\n");
          await checkout.commit({
            files: ["src.txt"],
            subject: "fix: add missing line",
            body: ["- Add missing line"],
          });
          await checkout.push();
        },
      );

      const clone = join(root, "clone");
      await git(root, ["clone", "--branch", "main", remote, clone]);
      const author = await git(clone, ["log", "-1", "--format=%an <%ae>"]);
      const committer = await git(clone, ["log", "-1", "--format=%cn <%ce>"]);
      const message = await git(clone, ["log", "-1", "--format=%B"]);
      expect(author).toBe(`Alice <${human.email}>`);
      expect(committer).toBe(`Alice <${human.email}>`);
      expect(message).toContain("- Add missing line");
      expect(message).toContain(
        formatCoAuthoredByTrailer({
          name: "pr-agent[bot]",
          email: githubNoreplyEmail(123, "pr-agent[bot]"),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("appends Co-authored-by trailers after body with a blank line", () => {
    const app = { name: "pr-agent[bot]", email: "123+pr-agent[bot]@users.noreply.github.com" };
    expect(
      buildCommitCommandArgs({
        files: ["x"],
        subject: "fix: guard null user",
        body: ["- Cover null user path"],
        coAuthoredBy: [app],
      }),
    ).toEqual([
      "commit",
      "-n",
      "-m",
      "fix: guard null user",
      "-m",
      `- Cover null user path\n\n${formatCoAuthoredByTrailer(app)}`,
    ]);
    expect(
      buildCommitCommandArgs({
        files: ["x"],
        subject: "fix: guard null user",
        coAuthoredBy: [app],
      }),
    ).toEqual(["commit", "-n", "-m", "fix: guard null user", "-m", formatCoAuthoredByTrailer(app)]);
    expect(() =>
      buildCommitCommandArgs({
        files: ["x"],
        subject: "fix: guard null user",
        coAuthoredBy: [{ name: "bad <name>", email: "a@b.com" }],
      }),
    ).toThrow(/coAuthoredBy name is invalid/);
  });

  it("builds human vs app triage commit attribution", () => {
    const bot = { userId: 123, login: "pr-agent[bot]" };
    const human = {
      name: "Alice",
      email: githubNoreplyEmail(42, "alice"),
    };
    expect(buildTriageCommitAttribution({ botIdentity: bot, triggerer: human })).toEqual({
      person: human,
      coAuthoredBy: [{ name: "pr-agent[bot]", email: githubNoreplyEmail(123, "pr-agent[bot]") }],
      source: "human",
    });
    expect(buildTriageCommitAttribution({ botIdentity: bot, triggerer: null })).toEqual({
      person: { name: "pr-agent[bot]", email: githubNoreplyEmail(123, "pr-agent[bot]") },
      coAuthoredBy: [],
      source: "app",
    });
  });

  it("sanitizes line breaks and null bytes in GitHub profile names", () => {
    expect(
      gitPersonFromGithubUser({
        id: 42,
        login: "alice",
        name: "Alice\nEvil\rTrailer",
        type: "User",
      }),
    ).toEqual({ name: "Alice Evil Trailer", email: githubNoreplyEmail(42, "alice") });
    expect(
      gitPersonFromGithubUser({
        id: 42,
        login: "alice",
        name: "\n\r\n",
        type: "User",
      }),
    ).toEqual({ name: "alice", email: githubNoreplyEmail(42, "alice") });
    expect(
      gitPersonFromGithubUser({
        id: 42,
        login: "alice",
        name: "Alice\0Evil",
        type: "User",
      }),
    ).toEqual({ name: "Alice Evil", email: githubNoreplyEmail(42, "alice") });
    expect(
      gitPersonFromGithubUser({
        id: 42,
        login: "alice",
        name: "\0\0",
        type: "User",
      }),
    ).toEqual({ name: "alice", email: githubNoreplyEmail(42, "alice") });
  });

  it("rejects commit identities with forbidden characters in name or email", () => {
    const subject = "fix: guard null user";
    const validCoAuthor = { name: "Bot", email: "bot@example.com" };

    for (const name of ["Alice\nInject", "Alice\0Inject"]) {
      try {
        gitIdentityEnv({ name, email: "alice@example.com" });
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("pr_workspace.commit_identity_invalid");
        continue;
      }
      expect.unreachable(`gitIdentityEnv accepted forbidden name ${JSON.stringify(name)}`);
    }
    try {
      gitIdentityEnv({ name: "Alice", email: "alice\n@example.com" });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("pr_workspace.commit_identity_invalid");
    }
    try {
      gitIdentityEnv({ name: "Alice\r", email: "alice@example.com" });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("pr_workspace.commit_identity_invalid");
    }

    for (const coAuthor of [
      { name: "Co\nAuthor", email: "co@example.com" },
      { name: "Co\0Author", email: "co@example.com" },
    ]) {
      try {
        buildCommitCommandArgs({
          files: ["x"],
          subject,
          coAuthoredBy: [coAuthor],
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("pr_workspace.commit_identity_invalid");
        continue;
      }
      expect.unreachable(
        `buildCommitCommandArgs accepted forbidden co-author ${JSON.stringify(coAuthor)}`,
      );
    }
    expect(() =>
      buildCommitCommandArgs({
        files: ["x"],
        subject,
        coAuthoredBy: [validCoAuthor, { name: "Other", email: "other\r@example.com" }],
      }),
    ).toThrow(AppError);
    try {
      buildCommitCommandArgs({
        files: ["x"],
        subject,
        coAuthoredBy: [{ name: "Co", email: "co@example.com\0" }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("pr_workspace.commit_identity_invalid");
    }

    const personFromUntrustedProfile = gitPersonFromGithubUser({
      id: 42,
      login: "alice",
      name: "Alice",
      email: "alice\n@example.com",
      type: "User",
    });
    expect(personFromUntrustedProfile).not.toBeNull();
    try {
      gitIdentityEnv(personFromUntrustedProfile!);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("pr_workspace.commit_identity_invalid");
    }
  });

  it("maps GitHub users to git people with noreply and bot rejection", () => {
    expect(
      gitPersonFromGithubUser({
        id: 42,
        login: "alice",
        name: "Alice Example",
        email: null,
        type: "User",
      }),
    ).toEqual({ name: "Alice Example", email: githubNoreplyEmail(42, "alice") });
    expect(
      gitPersonFromGithubUser({
        id: 42,
        login: "alice",
        name: null,
        email: "alice@example.com",
        type: "User",
      }),
    ).toEqual({ name: "alice", email: "alice@example.com" });
    expect(
      gitPersonFromGithubUser({
        id: 99,
        login: "dependabot[bot]",
        name: "Dependabot",
        type: "Bot",
      }),
    ).toBeNull();
    expect(
      gitPersonFromGithubUser({
        id: 123,
        login: "pr-agent[bot]",
        name: "PR Agent",
        type: "User",
      }),
    ).toBeNull();
  });

  it("surfaces non-fast-forward pushes as StaleHeadPushError", async () => {
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
  });

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

  it("rejects unsafe paths and resets index after oversized staged diff", async () => {
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
  });

  it("releases root and credential files after injected credential-setup failure", async () => {
    credentialHooks.failAfterWrite = true;
    const dirsBefore = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("pr-agent-triage-")),
    );
    await expect(
      withWritablePrCheckout(
        {
          owner: "owner",
          repo: "repo",
          headRef: "main",
          headSha: "a".repeat(40),
          installationToken: "ghs_INJECTED_CREDENTIAL_FAILURE_TOKEN",
          botIdentity: { userId: 123, login: "pr-agent[bot]" },
        },
        async () => undefined,
      ),
    ).rejects.toThrow(/injected credential setup failure/);
    const dirsAfter = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("pr-agent-triage-"),
    );
    expect(dirsAfter.every((name) => dirsBefore.has(name))).toBe(true);
  });

  it("removes stale triage checkout dirs with local workspace cleanup", async () => {
    const staleDir = await mkdtemp(join(tmpdir(), "pr-agent-triage-test-"));
    try {
      await mkdir(join(staleDir, "checkout"), { recursive: true });
      const old = new Date(Date.now() - 10_000);
      await utimes(staleDir, old, old);

      await cleanupStaleLocalPrWorkspaces({ staleAgeSeconds: 1 });

      await expect(stat(staleDir)).rejects.toThrow();
    } finally {
      await rm(staleDir, { recursive: true, force: true });
    }
  });

  it("deletes stale read-spill files and keeps fresh ones", async () => {
    const stale = await spillTextToSessionFile("stale-spill-body\n", {
      workItemId: "stale-item",
      toolCall: "read",
    });
    const fresh = await spillTextToSessionFile("fresh-spill-body\n", {
      workItemId: "fresh-item",
      toolCall: "read",
    });
    try {
      const old = new Date(Date.now() - 10_000);
      await utimes(stale.spillPath, old, old);
      expect((await stat(fresh.spillPath)).mode & 0o777).toBe(0o600);

      await cleanupStaleLocalPrWorkspaces({ staleAgeSeconds: 1 });

      await expect(stat(stale.spillPath)).rejects.toThrow();
      expect(await readFile(fresh.spillPath, "utf8")).toBe("fresh-spill-body\n");
    } finally {
      await rm(stale.spillPath, { force: true });
      await rm(fresh.spillPath, { force: true });
    }
  });

  it("strips attacker-controlled symlinks before exposing the checkout", async () => {
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
  });

  it("commits legitimate tracked-file deletions including removed parent directories", async () => {
    const { root, repo, remote } = await makeRemote();
    try {
      await mkdir(join(repo, "nested"), { recursive: true });
      await writeFile(join(repo, "nested/remove-me.txt"), "temp\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "add nested file"]);
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
          await rm(join(checkout.dir, "src.txt"));
          await rm(join(checkout.dir, "nested"), { recursive: true });

          const before = await git(checkout.dir, ["write-tree"]);
          await expect(
            checkout.commit({ files: ["nested"], subject: "fix: require a file path" }),
          ).rejects.toMatchObject({ code: "pr_workspace.path_traversal" });
          expect(await git(checkout.dir, ["rev-parse", "HEAD"])).toBe(headSha);
          expect(await git(checkout.dir, ["write-tree"])).toBe(before);

          const result = await checkout.commit({
            files: ["./src.txt", "nested/remove-me.txt"],
            subject: "fix: delete obsolete tracked files",
          });
          expect(result.sha).not.toBe(headSha);
          expect(result.diff).toContain("src.txt");
          expect(result.diff).toContain("nested/remove-me.txt");
          expect(await git(checkout.dir, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("");
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects synthetic symlinks and symlinked ancestors without mutating HEAD or index", async () => {
    const { root, remote, headSha } = await makeRemote();
    const outside = await mkdtemp(join(tmpdir(), "writable-checkout-outside-"));
    try {
      await writeFile(join(outside, "outside.txt"), "external fixture\n");

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
          await mkdir(join(checkout.dir, "nested"), { recursive: true });
          await writeFile(join(checkout.dir, "nested/plain.txt"), "plain\n");
          await symlink(join(outside, "outside.txt"), join(checkout.dir, "outside-link.txt"));
          await symlink("src.txt", join(checkout.dir, "inside-link.txt"));
          await symlink(join(outside, "missing.txt"), join(checkout.dir, "dangling-link.txt"));
          await symlink(outside, join(checkout.dir, "outside-dir"));
          await symlink("nested", join(checkout.dir, "inside-dir"));

          await writeFile(join(checkout.dir, "src.txt"), "one\nstaged\n");
          await git(checkout.dir, ["add", "--", "src.txt"]);

          const symlinkCases = [
            "outside-link.txt",
            "inside-link.txt",
            "dangling-link.txt",
            "outside-dir/outside.txt",
            "outside-dir/missing.txt",
            "inside-dir/plain.txt",
          ];

          for (const candidate of symlinkCases) {
            await expect(
              checkout.commit({
                files: [candidate],
                subject: "fix: reject symlink path",
              }),
            ).rejects.toSatisfy((error: unknown) => {
              expect(error).toBeInstanceOf(AppError);
              expect((error as AppError).code).toBe("pr_workspace.symlink_escape");
              return true;
            });
            expect(await git(checkout.dir, ["rev-parse", "HEAD"])).toBe(headSha);
            expect(await git(checkout.dir, ["diff", "--cached", "--name-only"])).toBe("src.txt");
          }

          const replay = await replayPreviewHunks({
            checkout,
            hunks: [
              {
                threadRootCommentId: 7,
                subject: "fix: reject preview symlink path",
                diff: "diff --git a/outside-link.txt b/outside-link.txt\n--- a/outside-link.txt\n+++ b/outside-link.txt\n@@ -1 +1 @@\n-a\n+b\n",
              },
            ],
            applyDiff: async () => undefined,
          });
          expect(replay.commitByThreadRootCommentId.size).toBe(0);
          expect(replay.commitErrors).toHaveLength(1);
          expect(replay.commitErrors[0]?.error).toMatch(/symlink/i);
          expect(await git(checkout.dir, ["rev-parse", "HEAD"])).toBe(headSha);
        },
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects root, directories, sensitive variants, and pathspec globs without mutating HEAD or index", async () => {
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
          await mkdir(join(checkout.dir, "nested"), { recursive: true });
          await writeFile(join(checkout.dir, "nested/plain.txt"), "plain\n");
          await writeFile(join(checkout.dir, "other.txt"), "other\n");
          await writeFile(join(checkout.dir, "src.txt"), "one\nstaged\n");
          await git(checkout.dir, ["add", "--", "src.txt"]);

          for (const badPath of ["", ".", "./", "nested"]) {
            await expect(
              checkout.commit({
                files: [badPath],
                subject: "fix: reject non-file path",
              }),
            ).rejects.toSatisfy((error: unknown) => {
              expect(error).toBeInstanceOf(AppError);
              expect((error as AppError).code).toBe("pr_workspace.path_traversal");
              return true;
            });
            expect(await git(checkout.dir, ["rev-parse", "HEAD"])).toBe(headSha);
            expect(await git(checkout.dir, ["diff", "--cached", "--name-only"])).toBe("src.txt");
          }

          for (const sensitive of ["./.env", ".git/config", "./.github/workflows/ci.yml"]) {
            await expect(
              checkout.commit({
                files: [sensitive],
                subject: "fix: reject sensitive path",
              }),
            ).rejects.toSatisfy((error: unknown) => {
              expect(error).toBeInstanceOf(AppError);
              expect((error as AppError).code).toBe("pr_workspace.sensitive_path");
              return true;
            });
            expect(await git(checkout.dir, ["rev-parse", "HEAD"])).toBe(headSha);
            expect(await git(checkout.dir, ["diff", "--cached", "--name-only"])).toBe("src.txt");
          }

          await expect(
            checkout.commit({
              files: ["*.txt"],
              subject: "fix: reject glob pathspec",
            }),
          ).rejects.toMatchObject({ code: "pr_workspace.path_traversal" });
          expect(await git(checkout.dir, ["rev-parse", "HEAD"])).toBe(headSha);
          expect(await git(checkout.dir, ["diff", "--cached", "--name-only"])).toBe("src.txt");

          const committed = await checkout.commit({
            files: ["./src.txt"],
            subject: "fix: commit normalized regular file",
          });
          expect(committed.sha).not.toBe(headSha);
          expect(committed.diff).toContain("src.txt");
          expect(committed.diff).not.toContain("other.txt");
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects case-variant blocked paths", async () => {
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
          await writeFile(join(checkout.dir, "src.txt"), "one\nstaged\n");
          await git(checkout.dir, ["add", "--", "src.txt"]);

          for (const sensitive of [".GIT/config", ".Git/hooks/x", ".ENV"]) {
            await expect(
              checkout.commit({
                files: [sensitive],
                subject: "fix: reject case variant path",
              }),
            ).rejects.toSatisfy((error: unknown) => {
              expect(error).toBeInstanceOf(AppError);
              expect((error as AppError).code).toBe("pr_workspace.sensitive_path");
              return true;
            });
            expect(await git(checkout.dir, ["rev-parse", "HEAD"])).toBe(headSha);
            expect(await git(checkout.dir, ["diff", "--cached", "--name-only"])).toBe("src.txt");
          }
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects too many files", async () => {
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
          await writeFile(join(checkout.dir, "src.txt"), "one\nstaged\n");
          await git(checkout.dir, ["add", "--", "src.txt"]);
          const names = Array.from(
            { length: 21 },
            (_, index) => `file-${String(index).padStart(2, "0")}.txt`,
          );
          for (const name of names) {
            await writeFile(join(checkout.dir, name), "x\n");
          }

          await expect(
            checkout.commit({
              files: ["src.txt", "./src.txt", ...names],
              subject: "fix: reject oversized file list",
            }),
          ).rejects.toMatchObject({ code: "pr_workspace.commit_fix_too_many_files" });
          expect(await git(checkout.dir, ["rev-parse", "HEAD"])).toBe(headSha);
          expect(await git(checkout.dir, ["diff", "--cached", "--name-only"])).toBe("src.txt");
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-blob deletion", async () => {
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
          await symlink("src.txt", join(checkout.dir, "tracked-link.txt"));
          await git(checkout.dir, ["add", "--", "tracked-link.txt"]);
          await git(checkout.dir, ["commit", "-m", "track symlink"]);
          const linkHead = await git(checkout.dir, ["rev-parse", "HEAD"]);
          const linkTree = await git(checkout.dir, ["write-tree"]);
          expect(await git(checkout.dir, ["ls-tree", "HEAD", "tracked-link.txt"])).toMatch(
            /^120000 /,
          );
          await rm(join(checkout.dir, "tracked-link.txt"));

          await expect(
            checkout.commit({
              files: ["tracked-link.txt"],
              subject: "fix: reject symlink deletion",
            }),
          ).rejects.toMatchObject({ code: "pr_workspace.path_traversal" });
          expect(await git(checkout.dir, ["rev-parse", "HEAD"])).toBe(linkHead);
          expect(await git(checkout.dir, ["write-tree"])).toBe(linkTree);

          const gitlink = await git(checkout.dir, ["rev-parse", "HEAD"]);
          await git(checkout.dir, [
            "update-index",
            "--add",
            "--cacheinfo",
            `160000,${gitlink},tracked-submodule`,
          ]);
          await git(checkout.dir, ["commit", "-m", "track gitlink"]);
          const gitlinkHead = await git(checkout.dir, ["rev-parse", "HEAD"]);
          const gitlinkTree = await git(checkout.dir, ["write-tree"]);
          expect(await git(checkout.dir, ["ls-tree", "HEAD", "tracked-submodule"])).toMatch(
            /^160000 /,
          );

          await expect(
            checkout.commit({
              files: ["tracked-submodule"],
              subject: "fix: reject gitlink deletion",
            }),
          ).rejects.toMatchObject({ code: "pr_workspace.path_traversal" });
          expect(await git(checkout.dir, ["rev-parse", "HEAD"])).toBe(gitlinkHead);
          expect(await git(checkout.dir, ["write-tree"])).toBe(gitlinkTree);
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
