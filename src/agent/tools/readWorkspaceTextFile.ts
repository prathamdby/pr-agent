import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_WORKSPACE_READ_SPILL_TAIL_BYTES,
  LOCAL_WORKSPACE_READ_SPILL_THRESHOLD_BYTES,
  READ_SPILL_FILENAME_PREFIX,
} from "../../settings/index.ts";
import {
  readTextWithOutputBudget,
  shouldSpillToFile,
  type FileReadOutput,
  type FileReadWindowParams,
} from "./toolOutputBudget.ts";

export { READ_SPILL_FILENAME_PREFIX };

export const MISSING_FROM_CHECKOUT_REASON = "Path is missing from the checkout.";
export const BINARY_FILE_REASON = "Binary file cannot be read as text.";

const BINARY_SAMPLE_BYTES = 8192;

export type WorkspaceTextFileRefusal = {
  readonly refused: true;
  readonly refusalKind: "missing" | "special" | "too-large" | "binary";
  readonly reason: string;
};

export type WorkspaceTextFileReadResult =
  | WorkspaceTextFileRefusal
  | {
      readonly refused?: undefined;
      readonly size: number;
      readonly content: string;
      readonly note?: string;
    };

type StatReadTarget =
  | WorkspaceTextFileRefusal
  | { readonly refused?: undefined; readonly size: number };

function specialFileKind(info: Stats) {
  if (info.isFile()) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (info.isDirectory())
    return ((pinnedReturn: string | undefined) => pinnedReturn)("a directory");
  if (info.isFIFO())
    return ((pinnedReturn: string | undefined) => pinnedReturn)("a FIFO (named pipe)");
  if (info.isSocket()) return ((pinnedReturn: string | undefined) => pinnedReturn)("a socket");
  if (info.isCharacterDevice())
    return ((pinnedReturn: string | undefined) => pinnedReturn)("a character device");
  if (info.isBlockDevice())
    return ((pinnedReturn: string | undefined) => pinnedReturn)("a block device");
  return ((pinnedReturn: string | undefined) => pinnedReturn)("a special (non-regular) file");
}

async function statReadTarget(fullPath: string, maxFileBytes: number) {
  const info = await stat(fullPath).catch(() => null);
  if (!info) {
    return ((pinnedReturn: StatReadTarget | Promise<StatReadTarget>) => pinnedReturn)({
      refused: true,
      refusalKind: "missing",
      reason: MISSING_FROM_CHECKOUT_REASON,
    });
  }
  const fileKind = specialFileKind(info);
  if (fileKind !== undefined) {
    return ((pinnedReturn: StatReadTarget | Promise<StatReadTarget>) => pinnedReturn)({
      refused: true,
      refusalKind: "special",
      reason: `Path is ${fileKind}, not a regular file; no read was attempted.`,
    });
  }
  if (info.size > maxFileBytes) {
    return ((pinnedReturn: StatReadTarget | Promise<StatReadTarget>) => pinnedReturn)({
      refused: true,
      refusalKind: "too-large",
      reason: `File exceeds ${maxFileBytes} byte read limit.`,
    });
  }
  return ((pinnedReturn: StatReadTarget | Promise<StatReadTarget>) => pinnedReturn)({
    size: info.size,
  });
}

export async function refuseWorkspaceTextFileRead(fullPath: string, maxFileBytes: number) {
  const target = await statReadTarget(fullPath, maxFileBytes);
  return ((
    pinnedReturn: (WorkspaceTextFileRefusal | null) | Promise<WorkspaceTextFileRefusal | null>,
  ) => pinnedReturn)(target.refused ? target : null);
}

export function normalizeTextFileEncoding(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"),
  );
}

export async function readWorkspaceTextFile(fullPath: string, maxFileBytes: number) {
  const target = await statReadTarget(fullPath, maxFileBytes);
  if (target.refused) {
    return ((pinnedReturn: WorkspaceTextFileReadResult | Promise<WorkspaceTextFileReadResult>) =>
      pinnedReturn)(target);
  }
  const content = normalizeTextFileEncoding(await readFile(fullPath, "utf8"));
  return ((pinnedReturn: WorkspaceTextFileReadResult | Promise<WorkspaceTextFileReadResult>) =>
    pinnedReturn)({
    size: target.size,
    content,
    ...(target.size === 0 ? { note: "File is empty (0 bytes)." } : {}),
  });
}

export type BudgetedWorkspaceTextFileRead =
  | WorkspaceTextFileRefusal
  | (FileReadOutput & { readonly refused?: undefined });

const RESPONSE_BYTE_BUDGET_TRUNCATION_REASON = "response byte budget exceeded";

export async function readBudgetedWorkspaceTextFile(
  fullPath: string,
  opts: {
    readonly maxFileBytes: number;
    readonly maxResponseBytes: number;
    readonly window?: FileReadWindowParams;
    readonly spillTailBytes?: number;
    readonly spillScope?: TextSpillScope;
  },
) {
  const result = await readWorkspaceTextFile(fullPath, opts.maxFileBytes);
  if (result.refused) {
    return ((
      pinnedReturn:
        | (BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead)
        | Promise<BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead>,
    ) => pinnedReturn)(result);
  }
  if (result.content.slice(0, BINARY_SAMPLE_BYTES).includes("\0")) {
    return ((
      pinnedReturn:
        | (BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead)
        | Promise<BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead>,
    ) => pinnedReturn)({ refused: true, refusalKind: "binary", reason: BINARY_FILE_REASON });
  }
  const readOutput = readTextWithOutputBudget(result.content, opts.maxResponseBytes, opts.window);
  const note = [result.note, readOutput.note].filter(Boolean).join(" ");
  const budgeted: BudgetedWorkspaceTextFileRead = {
    ...readOutput,
    ...(note ? { note } : {}),
  };
  if (
    budgeted.refused ||
    !budgeted.truncated ||
    budgeted.truncationReason !== RESPONSE_BYTE_BUDGET_TRUNCATION_REASON ||
    opts.spillScope === undefined
  ) {
    return ((
      pinnedReturn:
        | (BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead)
        | Promise<BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead>,
    ) => pinnedReturn)(budgeted);
  }
  if (!shouldSpillToFile(budgeted.size, LOCAL_WORKSPACE_READ_SPILL_THRESHOLD_BYTES)) {
    return ((
      pinnedReturn:
        | (BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead)
        | Promise<BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead>,
    ) => pinnedReturn)(budgeted);
  }
  return ((
    pinnedReturn:
      | (BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead)
      | Promise<BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead>,
  ) => pinnedReturn)(
    spillTextToSessionFile(result.content, opts.spillScope, {
      tailBytes: opts.spillTailBytes,
    }),
  );
}

export type TextSpillScope = {
  readonly workItemId: string;
  readonly toolCall: string;
};

export type SpilledWorkspaceTextFileRead = {
  readonly refused?: undefined;
  readonly spilled: true;
  readonly path: string;
  readonly spillPath: string;
  readonly size: number;
  readonly tail: string;
  readonly truncated: true;
  readonly note: string;
};

export async function spillTextToSessionFile(
  text: string,
  scope: TextSpillScope,
  opts?: { readonly tailBytes?: number },
) {
  const tailBytes = opts?.tailBytes ?? LOCAL_WORKSPACE_READ_SPILL_TAIL_BYTES;
  const size = Buffer.byteLength(text, "utf8");
  const cleanWorkItem = scope.workItemId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const cleanToolCall = scope.toolCall.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const fileName = `${READ_SPILL_FILENAME_PREFIX}${cleanWorkItem.length > 0 ? cleanWorkItem : "call"}-${cleanToolCall.length > 0 ? cleanToolCall : "call"}-${randomUUID().slice(0, 8)}.txt`;
  const spillPath = join(tmpdir(), fileName);
  await writeFile(spillPath, text, { encoding: "utf8", mode: 0o600 });
  const buf = Buffer.from(text, "utf8");
  let tail: string;
  if (buf.length <= tailBytes) {
    tail = text;
  } else {
    let start = buf.length - tailBytes;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
      start += 1;
    }
    tail = buf.subarray(start).toString("utf8");
  }
  return ((pinnedReturn: SpilledWorkspaceTextFileRead | Promise<SpilledWorkspaceTextFileRead>) =>
    pinnedReturn)({
    spilled: true,
    path: spillPath,
    spillPath,
    size,
    tail,
    truncated: true,
    note: `Output (${size} bytes) exceeded the spill threshold; full text spilled to ${spillPath}. Spilled content is not read evidence — re-read the source path via readWorkspaceFile with explicit startLine/maxLines before citing any line in a finding.`,
  });
}

export async function disposeSpillFile(spillPath: string) {
  const base = spillPath.split(/[\\/]/).pop() ?? "";
  if (!base.startsWith(READ_SPILL_FILENAME_PREFIX)) {
    return;
  }
  await rm(spillPath, { force: true });
}
