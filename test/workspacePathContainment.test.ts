import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertContainedWorkspacePath,
  stripWorkspaceSymlinks,
} from "../src/prWorkspace/localPrWorkspace.js";

describe("workspace path containment", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  it("allows ordinary files inside the root", async () => {
    const root = await tempRoot("ws-contain-");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/app.ts"), "export {};\n");
    const full = await assertContainedWorkspacePath(root, "src/app.ts");
    expect(full).toBe(join(root, "src/app.ts"));
  });

  it("rejects absolute symlink escapes", async () => {
    const root = await tempRoot("ws-contain-");
    const outside = await tempRoot("ws-outside-");
    await writeFile(join(outside, "secret.env"), "TOKEN=leak\n");
    await mkdir(join(root, "docs"), { recursive: true });
    await symlink(join(outside, "secret.env"), join(root, "docs/notes.md"));

    await expect(assertContainedWorkspacePath(root, "docs/notes.md")).rejects.toMatchObject({
      code: "pr_workspace.symlink_escape",
    });
  });

  it("rejects relative symlink escapes to a sibling credential file", async () => {
    const parent = await tempRoot("ws-parent-");
    const root = join(parent, "checkout");
    await mkdir(root, { recursive: true });
    await writeFile(join(parent, "git-token"), "ghs_INSTALLATION_TOKEN_TESTVALUE0123456789");
    await symlink("../git-token", join(root, "notes.md"));

    await expect(assertContainedWorkspacePath(root, "notes.md")).rejects.toMatchObject({
      code: "pr_workspace.symlink_escape",
    });
  });

  it("stripWorkspaceSymlinks removes links and leaves regular files", async () => {
    const root = await tempRoot("ws-strip-");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs/ok.md"), "ok\n");
    await symlink("/etc/passwd", join(root, "docs/bad.md"));
    await stripWorkspaceSymlinks(root);
    await expect(assertContainedWorkspacePath(root, "docs/ok.md")).resolves.toBe(
      join(root, "docs/ok.md"),
    );
    await expect(lstat(join(root, "docs/bad.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
