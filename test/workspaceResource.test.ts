import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_TOKEN_FILE_NAME } from "../src/prWorkspace/gitCredentials.js";
import {
  allocateWorkspaceResource,
  READONLY_WORKSPACE_ROOT_PREFIX,
  sweepStaleOwnedWorkspaces,
  WRITABLE_WORKSPACE_ROOT_PREFIX,
} from "../src/prWorkspace/workspaceResource.js";

const STALE_AGE_MS = 3_600_000;

async function workspaceDirs(prefix: string): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(prefix));
}

describe("WorkspaceResource", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }),
    );
  });

  it("releases root and credential files after injected credential-setup failure", async () => {
    const dirsBefore = new Set(await workspaceDirs(READONLY_WORKSPACE_ROOT_PREFIX));
    let leakedRoot: string | undefined;

    await expect(
      allocateWorkspaceResource({
        prefix: READONLY_WORKSPACE_ROOT_PREFIX,
        installationToken: "ghs_INJECTED_CREDENTIAL_FAILURE_TOKEN",
        createCredentials: async (rootDir, token) => {
          leakedRoot = rootDir;
          await writeFile(join(rootDir, GIT_TOKEN_FILE_NAME), token, { mode: 0o600 });
          throw new Error("injected credential setup failure");
        },
      }),
    ).rejects.toThrow(/injected credential setup failure/);

    expect(leakedRoot).toEqual(expect.stringContaining(READONLY_WORKSPACE_ROOT_PREFIX));
    await expect(stat(leakedRoot as string)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(leakedRoot as string, GIT_TOKEN_FILE_NAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const dirsAfter = await workspaceDirs(READONLY_WORKSPACE_ROOT_PREFIX);
    expect(dirsAfter.every((name) => dirsBefore.has(name))).toBe(true);
  });

  it("releases a partial root when credential setup throws before writing files", async () => {
    let leakedRoot: string | undefined;
    await expect(
      allocateWorkspaceResource({
        prefix: WRITABLE_WORKSPACE_ROOT_PREFIX,
        installationToken: "unused",
        createCredentials: async (rootDir) => {
          leakedRoot = rootDir;
          throw new Error("injected dir failure");
        },
      }),
    ).rejects.toThrow(/injected dir failure/);
    await expect(stat(leakedRoot as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("release is idempotent for a live root and a missing root", async () => {
    const resource = await allocateWorkspaceResource({
      prefix: READONLY_WORKSPACE_ROOT_PREFIX,
      installationToken: "unused",
    });
    roots.push(resource.rootDir);
    const marker = JSON.parse(
      await readFile(join(resource.rootDir, ".pr-agent-workspace-owner.json"), "utf8"),
    );
    expect(marker?.pid).toBe(process.pid);
    expect(marker?.heartbeatAtMs).toBeGreaterThan(0);

    await resource.release();
    await expect(stat(resource.rootDir)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(resource.release()).resolves.toBeUndefined();
    await expect(resource.release()).resolves.toBeUndefined();
  });

  it("protects an allocated live root even with stale marker and directory ages", async () => {
    const resource = await allocateWorkspaceResource({
      prefix: READONLY_WORKSPACE_ROOT_PREFIX,
      installationToken: "unused",
    });
    roots.push(resource.rootDir);
    const stale = new Date(Date.now() - 4 * STALE_AGE_MS);
    await writeFile(
      join(resource.rootDir, ".pr-agent-workspace-owner.json"),
      JSON.stringify({ pid: process.pid, heartbeatAtMs: stale.getTime() }),
    );
    await utimes(resource.rootDir, stale, stale);
    await sweepStaleOwnedWorkspaces({ isPidAlive: () => false });
    expect((await stat(resource.rootDir)).isDirectory()).toBe(true);
    await resource.release();
    await expect(stat(resource.rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stale sweep skips another process's marked live root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), READONLY_WORKSPACE_ROOT_PREFIX));
    roots.push(rootDir);
    await mkdir(join(rootDir, "checkout"), { recursive: true });
    const stale = new Date(Date.now() - 4 * STALE_AGE_MS);
    await writeFile(
      join(rootDir, ".pr-agent-workspace-owner.json"),
      JSON.stringify({
        pid: process.pid,
        heartbeatAtMs: Date.now() - 4 * STALE_AGE_MS,
      }),
    );
    await utimes(rootDir, stale, stale);

    await sweepStaleOwnedWorkspaces({
      nowMs: Date.now(),
      isPidAlive: (pid) => pid === process.pid,
    });
    expect((await stat(rootDir)).isDirectory()).toBe(true);
  });

  it("stale sweep skips a recent heartbeat even when the owner pid is dead", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), WRITABLE_WORKSPACE_ROOT_PREFIX));
    roots.push(rootDir);
    await writeFile(
      join(rootDir, ".pr-agent-workspace-owner.json"),
      JSON.stringify({
        pid: 2_000_000_001,
        heartbeatAtMs: Date.now(),
      }),
    );
    const stale = new Date(Date.now() - 4 * STALE_AGE_MS);
    await utimes(rootDir, stale, stale);

    await sweepStaleOwnedWorkspaces({
      nowMs: Date.now(),
      isPidAlive: () => false,
    });
    expect((await stat(rootDir)).isDirectory()).toBe(true);
  });

  it("stale sweep deletes a crashed owner's marked root after the grace period", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), READONLY_WORKSPACE_ROOT_PREFIX));
    try {
      await writeFile(
        join(rootDir, ".pr-agent-workspace-owner.json"),
        JSON.stringify({
          pid: 2_000_000_002,
          heartbeatAtMs: Date.now() - 4 * STALE_AGE_MS,
        }),
      );
      const stale = new Date(Date.now() - 4 * STALE_AGE_MS);
      await utimes(rootDir, stale, stale);

      await sweepStaleOwnedWorkspaces({
        nowMs: Date.now(),
        isPidAlive: () => false,
      });
      await expect(stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("stale sweep deletes an unmarked stale root even when the owner pid is alive", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), READONLY_WORKSPACE_ROOT_PREFIX));
    try {
      await mkdir(join(rootDir, "checkout"), { recursive: true });
      const stale = new Date(Date.now() - 4 * STALE_AGE_MS);
      await utimes(rootDir, stale, stale);

      await sweepStaleOwnedWorkspaces({
        nowMs: Date.now(),
        isPidAlive: () => true,
      });
      await expect(stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("clears the ownership marker when root deletion fails so a later sweep can collect it", async () => {
    const resource = await allocateWorkspaceResource({
      prefix: READONLY_WORKSPACE_ROOT_PREFIX,
      installationToken: "unused",
      removeRoot: async () => {
        throw new Error("injected root deletion failure");
      },
    });
    roots.push(resource.rootDir);

    await resource.release();
    await expect(
      stat(join(resource.rootDir, ".pr-agent-workspace-owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(resource.rootDir)).isDirectory()).toBe(true);

    const stale = new Date(Date.now() - 4 * STALE_AGE_MS);
    await utimes(resource.rootDir, stale, stale);
    await sweepStaleOwnedWorkspaces({
      nowMs: Date.now(),
      isPidAlive: () => true,
    });
    await expect(stat(resource.rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
