import { execFile as execFileCb } from "node:child_process";
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
vi.mock("../src/settings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/index.js")>();
  return { ...actual, LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS: 1 };
});
vi.mock("../src/prWorkspace/gitCredentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/prWorkspace/gitCredentials.js")>();
  return {
    ...actual,
    async createGitCredentialFiles(rootDir: string, token: string) {
      const created = await actual.createGitCredentialFiles(rootDir, token);
      if (credentialHooks.failAfterWrite) {
        throw new Error("injected credential setup failure");
      }
      return created;
    },
  };
});
import { AppError } from "../src/errors/appError.js";
import {
  buildCommitCommandArgs,
  buildTriageCommitAttribution,
  formatCoAuthoredByTrailer,
  gitPersonFromGithubUser,
  githubNoreplyEmail,
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

afterEach(() => {
  credentialHooks.failAfterWrite = false;
});

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
        const author = await git(clone, ["log", "-1", "--format=%an <%ae>"]);
        const committer = await git(clone, ["log", "-1", "--format=%cn <%ce>"]);
        const message = await git(clone, ["log", "-1", "--format=%B"]);
        expect(author).toBe("pr-agent[bot] <123+pr-agent[bot]@users.noreply.github.com>");
        expect(committer).toBe("pr-agent[bot] <123+pr-agent[bot]@users.noreply.github.com>");
        expect(message).not.toContain("Co-authored-by:");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "attributes human triggerer as author/committer with App Co-authored-by",
    async () => {
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
