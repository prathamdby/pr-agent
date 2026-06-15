import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { defineLocalTool, type LocalTool } from "./localToolBundle.js";

const BINARY_SAMPLE_BYTES = 8192;

export function looksBinary(sample: Buffer): boolean {
  return sample.includes(0);
}

export async function statTextFileForRead(
  fullPath: string,
  maxBytes: number,
  missingReason = "Path is missing from the checkout.",
  oversizeReason?: string,
): Promise<{ ok: true; size: number } | { refused: true; reason: string }> {
  const info = await stat(fullPath).catch(() => null);
  if (!info?.isFile()) {
    return { refused: true, reason: missingReason };
  }
  if (info.size > maxBytes) {
    return {
      refused: true,
      reason: oversizeReason ?? `File exceeds ${maxBytes} byte read limit.`,
    };
  }
  return { ok: true, size: info.size };
}

export async function readTextFileContent(
  fullPath: string,
  opts?: { checkBinary?: boolean },
): Promise<{ content: string } | { refused: true; reason: string }> {
  const buf = await readFile(fullPath);
  if (
    opts?.checkBinary &&
    looksBinary(buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES)))
  ) {
    return { refused: true, reason: "Binary file cannot be read as text." };
  }
  return { content: buf.toString("utf8") };
}

const pathSchema = z.object({ path: z.string().min(1) });

export function defineReadWorkspaceFileTool(
  description: string,
  run: LocalTool<typeof pathSchema>["run"],
): LocalTool {
  return defineLocalTool({
    description,
    schema: pathSchema,
    run,
  });
}

const searchSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().optional().default(20),
});

export function defineSearchWorkspaceTool(
  description: string,
  run: LocalTool<typeof searchSchema>["run"],
): LocalTool {
  return defineLocalTool({
    description,
    schema: searchSchema,
    run,
  });
}

export function defineGetWorkspaceDiffTool(
  description: string,
  run: LocalTool<typeof pathSchema>["run"],
): LocalTool {
  return defineLocalTool({
    description,
    schema: pathSchema,
    run,
  });
}
