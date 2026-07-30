import { readFile, stat } from "node:fs/promises";
import {
  hashNormalizedLineText,
  normalizeEvidencePath,
  type EvidenceLedger,
} from "../findings/evidenceLedger.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import { assertWorkspacePath } from "../../prWorkspace/localPrWorkspace.js";
import { readTextWithOutputBudget } from "../../agent/tools/toolOutputBudget.js";
import {
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
} from "../../settings/index.js";

const BINARY_SAMPLE_BYTES = 8192;
const SERVER_FILE_PASS_TOOL = "server_changed_file_pass";

export type ChangedFilePassBoundedFailure = {
  readonly path: string;
  readonly reason: string;
};

export type ChangedFilePassResult = {
  readonly attemptedPathCount: number;
  readonly inspectedPathCount: number;
  readonly boundedFailures: readonly ChangedFilePassBoundedFailure[];
  readonly unreadPaths: readonly string[];
  readonly stoppedForBudget: boolean;
};

function recordLedgerPath(
  ledger: EvidenceLedger,
  params: {
    readonly path: string;
    readonly headSha: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
  },
): void {
  ledger.record({
    path: params.path,
    startLine: params.startLine,
    endLine: params.endLine,
    contentHash: hashNormalizedLineText(params.content),
    headSha: params.headSha,
    tool: SERVER_FILE_PASS_TOOL,
  });
}

function recordBoundedAttempt(
  ledger: EvidenceLedger,
  path: string,
  headSha: string,
  reason: string,
): ChangedFilePassBoundedFailure {
  recordLedgerPath(ledger, {
    path,
    headSha,
    startLine: 1,
    endLine: 1,
    content: `bounded:${reason}`,
  });
  return { path, reason };
}

export async function runChangedFilePass(params: {
  readonly workspace: LocalPrWorkspace;
  readonly evidenceLedger: EvidenceLedger;
  readonly headSha: string;
  readonly maxFileBytes?: number;
  readonly readResponseBytes?: number;
  readonly shouldContinue: () => boolean;
}): Promise<ChangedFilePassResult> {
  const maxFileBytes = params.maxFileBytes ?? LOCAL_WORKSPACE_MAX_FILE_BYTES;
  const readResponseBytes = params.readResponseBytes ?? LOCAL_WORKSPACE_READ_RESPONSE_BYTES;
  const changedPaths = [
    ...new Set(params.workspace.changedFiles.map((file) => normalizeEvidencePath(file.path))),
  ].toSorted();
  const boundedFailures: ChangedFilePassBoundedFailure[] = [];
  let attemptedPathCount = 0;
  let stoppedForBudget = false;
  const unreadPaths: string[] = [];

  for (const path of changedPaths) {
    if (!params.shouldContinue()) {
      stoppedForBudget = true;
      unreadPaths.push(...changedPaths.slice(attemptedPathCount));
      break;
    }

    attemptedPathCount += 1;
    const changed = params.workspace.changedFileByPath.get(path);
    if (changed?.status === "deleted") {
      boundedFailures.push(
        recordBoundedAttempt(params.evidenceLedger, path, params.headSha, "deleted"),
      );
      continue;
    }

    if (!params.workspace.isPathInCheckout(path)) {
      boundedFailures.push(
        recordBoundedAttempt(params.evidenceLedger, path, params.headSha, "missing from checkout"),
      );
      continue;
    }

    const safePath = assertWorkspacePath(params.workspace.agentCwd, path);
    const info = await stat(safePath).catch(() => null);
    if (!info?.isFile()) {
      boundedFailures.push(
        recordBoundedAttempt(params.evidenceLedger, path, params.headSha, "missing from checkout"),
      );
      continue;
    }
    if (info.size > maxFileBytes) {
      boundedFailures.push(
        recordBoundedAttempt(
          params.evidenceLedger,
          path,
          params.headSha,
          `exceeds ${maxFileBytes} byte read limit`,
        ),
      );
      continue;
    }

    const buf = await readFile(safePath).catch(() => null);
    if (!buf) {
      boundedFailures.push(
        recordBoundedAttempt(params.evidenceLedger, path, params.headSha, "read failed"),
      );
      continue;
    }
    if (buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES)).includes(0)) {
      boundedFailures.push(
        recordBoundedAttempt(params.evidenceLedger, path, params.headSha, "binary"),
      );
      continue;
    }

    const text = buf.toString("utf8");
    const readOutput = readTextWithOutputBudget(text, readResponseBytes);
    recordLedgerPath(params.evidenceLedger, {
      path,
      headSha: params.headSha,
      startLine: readOutput.startLine > 0 ? readOutput.startLine : 1,
      endLine: readOutput.endLine > 0 ? readOutput.endLine : 1,
      content: readOutput.content,
    });
    if (readOutput.truncated) {
      boundedFailures.push({
        path,
        reason: readOutput.truncationReason ?? "response byte budget exceeded",
      });
    }
  }

  const inspectedPathCount = attemptedPathCount;
  return {
    attemptedPathCount,
    inspectedPathCount,
    boundedFailures,
    unreadPaths,
    stoppedForBudget,
  };
}
