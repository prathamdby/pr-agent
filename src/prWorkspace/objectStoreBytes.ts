import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY } from "../settings/index.ts";
import { AppError } from "../errors/appError.ts";

function missingDuringConcurrentWrite(error: unknown) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR"),
  );
}

async function regularFileAllocatedBytes(path: string) {
  const info = await lstat(path).catch((error: unknown) => {
    if (missingDuringConcurrentWrite(error)) return null;
    throw error;
  });
  if (info == null || !info.isFile()) return ((pinnedReturn: number) => pinnedReturn)(0);
  return ((pinnedReturn: number) => pinnedReturn)(info.blocks > 0 ? info.blocks * 512 : info.size);
}

export async function objectStoreAllocatedBytes(objectsDir: string) {
  let total = 0;
  const pending = [objectsDir];
  while (pending.length > 0) {
    const dirs = pending.splice(0, LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY);
    const scanned = await Promise.all(
      dirs.map(async (dir) => {
        const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
          if (missingDuringConcurrentWrite(error)) return null;
          throw error;
        });
        if (entries == null) return { files: [] as string[], dirs: [] as string[] };
        const files: string[] = [];
        const childDirs: string[] = [];
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) childDirs.push(full);
          else if (entry.isFile()) files.push(full);
        }
        return { files, dirs: childDirs };
      }),
    );
    const files: string[] = [];
    for (const scan of scanned) {
      files.push(...scan.files);
      pending.push(...scan.dirs);
    }
    for (let index = 0; index < files.length; index += LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY) {
      const sizes = await Promise.all(
        files
          .slice(index, index + LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY)
          .map((file) => regularFileAllocatedBytes(file)),
      );
      for (const size of sizes) total += size;
    }
  }
  return ((pinnedReturn: number | Promise<number>) => pinnedReturn)(total);
}

export function assertObjectStoreWithinCap(objectStoreBytes: number, maxFetchBytes: number) {
  if (objectStoreBytes <= maxFetchBytes) return;
  throw new AppError({
    domain: "pr_workspace",
    kind: "fetch_too_large",
    message: `PR fetch object store (${objectStoreBytes} bytes) exceeds LOCAL_WORKSPACE_MAX_FETCH_BYTES (${maxFetchBytes})`,
    context: { objectStoreBytes, maxFetchBytes },
  });
}

function systemErrorCode(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return ((pinnedReturn: string) => pinnedReturn)(code);
  }
  return ((pinnedReturn: string) => pinnedReturn)("UNKNOWN");
}

export async function enforceObjectStoreByteCap(objectsDir: string, maxFetchBytes: number) {
  const objectStoreBytes = await objectStoreAllocatedBytes(objectsDir).catch((error: unknown) => {
    throw new AppError({
      domain: "pr_workspace",
      kind: "git_failed",
      message: "PR fetch object store measurement failed",
      context: {
        objectStoreMonitorErrorCode: systemErrorCode(error),
        maxFetchBytes,
      },
    });
  });
  assertObjectStoreWithinCap(objectStoreBytes, maxFetchBytes);
}
