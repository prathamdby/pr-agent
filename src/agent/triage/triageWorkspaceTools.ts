import { buildWorkspaceTools, defineToolset } from "../tools/workspaceToolset.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import {
  type Config,
  TRIAGE_COMMIT_BODY_MAX_BULLETS,
  TRIAGE_NEW_FILE_MAX_BYTES,
  MAX_TRIAGE_FIXES_PER_RUN,
} from "../../settings/index.js";
import { AppError } from "../../errors/appError.js";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import { repoPathParam } from "../tools/toolParams.js";
import { defineLocalTool } from "../tools/defineWorkspaceTool.js";
import { normalizeTextFileEncoding } from "../tools/readWorkspaceTextFile.js";
import {
  assertTriageStagePaths,
  assertTriageWritablePath,
  normalizeRepoRelativePath,
} from "./triageWritePolicy.js";
import { errorMessage } from "../../errors/errorMessage.js";

export type TriageCommitError = {
  readonly threadRootCommentId: number;
  readonly error: string;
};

export type TriageWorkspaceToolState = {
  readonly commitByThreadRootCommentId: Map<number, string>;
  readonly commitErrors: TriageCommitError[];
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) return count;
    count++;
    offset = found + needle.length;
  }
}

/**
 * Map an offset in `normalizeTextFileEncoding(raw)` back to its offset in
 * `raw`, so an edit matched in normalized space can be spliced into the raw
 * bytes without rewriting line endings anywhere else in the file.
 */
function rawOffsetForNormalizedOffset(raw: string, normalizedOffset: number): number {
  let rawIndex = raw.startsWith("\uFEFF") ? 1 : 0;
  let normalizedIndex = 0;
  while (normalizedIndex < normalizedOffset && rawIndex < raw.length) {
    if (raw[rawIndex] === "\r" && raw[rawIndex + 1] === "\n") {
      rawIndex += 2;
    } else {
      rawIndex += 1;
    }
    normalizedIndex += 1;
  }
  return rawIndex;
}

export function createTriageWorkspaceToolState(): TriageWorkspaceToolState {
  return { commitByThreadRootCommentId: new Map(), commitErrors: [] };
}

export function buildTriageWorkspaceTools(params: {
  readonly cfg: Config;
  readonly checkout: WritablePrCheckout;
  readonly inventory: readonly BotFindingThread[];
  readonly state: TriageWorkspaceToolState;
}): {
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const inventoryIds = new Set(params.inventory.map((thread) => thread.rootCommentId));
  const implicatedPaths = new Set(
    params.inventory.map((thread) => normalizeRepoRelativePath(thread.path)),
  );
  const root = params.checkout.dir;

  const editWorkspaceFile = defineLocalTool({
    description:
      "Replace one exact span of text in a file named by a finding in the triage inventory. Other files are refused, so the fix stays inside what the finding implicates. oldText must occur exactly once; copy it from a fresh read and include enough surrounding lines to make it unique.",
    schema: v.object({
      path: repoPathParam,
      oldText: v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Text to replace, copied exactly from the file. Must occur once."),
      ),
      newText: v.pipe(v.string(), v.description("Replacement text. May be empty to delete.")),
    }),
    run: async ({ path, oldText, newText }) => {
      const { fullPath, relativePath: rel } = await assertTriageWritablePath({
        root,
        path,
        mode: "edit",
        implicatedPaths,
      });
      const content = await readFile(fullPath, "utf8");
      const matches = countOccurrences(content, oldText);
      if (matches === 1) {
        await writeFile(
          fullPath,
          content.replace(oldText, () => newText),
        );
        return { ok: true, path: rel };
      }
      if (matches > 1) {
        throw new AppError({
          domain: "triage",
          kind: "old_text_ambiguous",
          message: "oldText is ambiguous; include more surrounding context",
          context: { path: rel },
        });
      }
      // Reads show BOM-stripped, CRLF-normalized text, so oldText copied from
      // a read cannot exact-match the raw bytes of such files. Retry in the
      // normalized space the model actually saw, then splice the result back
      // into the raw bytes so the rest of the file keeps its own encoding.
      const hadBom = content.startsWith("\uFEFF");
      const hadCrlf = content.includes("\r\n");
      if (!hadBom && !hadCrlf) {
        throw new AppError({
          domain: "triage",
          kind: "old_text_not_found",
          message: "oldText not found; re-read the file",
          context: { path: rel },
        });
      }
      const normalized = normalizeTextFileEncoding(content);
      const normalizedOldText = normalizeTextFileEncoding(oldText);
      const normalizedMatches = countOccurrences(normalized, normalizedOldText);
      if (normalizedMatches === 0) {
        throw new AppError({
          domain: "triage",
          kind: "old_text_not_found",
          message: "oldText not found; re-read the file",
          context: { path: rel },
        });
      }
      if (normalizedMatches > 1) {
        throw new AppError({
          domain: "triage",
          kind: "old_text_ambiguous",
          message: "oldText is ambiguous; include more surrounding context",
          context: { path: rel },
        });
      }
      // Splice the raw bytes at the matched region instead of re-encoding the
      // whole file: a mixed-ending file keeps its LF-only lines, and newText
      // is normalized first so its own CRLFs cannot become "\r\r\n".
      const matchStart = normalized.indexOf(normalizedOldText);
      const rawStart = rawOffsetForNormalizedOffset(content, matchStart);
      const rawEnd = rawOffsetForNormalizedOffset(content, matchStart + normalizedOldText.length);
      const newTextLf = newText.replace(/\r\n/g, "\n");
      const replacement = hadCrlf ? newTextLf.replace(/\n/g, "\r\n") : newTextLf;
      await writeFile(fullPath, content.slice(0, rawStart) + replacement + content.slice(rawEnd));
      return { ok: true, path: rel };
    },
  });

  const createWorkspaceFile = defineLocalTool({
    description:
      "Create a new file in the writable checkout. Only test files, docs directories, and Markdown files can be created, and an existing path is refused. Use editWorkspaceFile to change an existing file.",
    schema: v.object({
      path: repoPathParam,
      content: v.pipe(
        v.string(),
        v.maxLength(TRIAGE_NEW_FILE_MAX_BYTES),
        v.check(
          (text) => Buffer.byteLength(text, "utf8") <= TRIAGE_NEW_FILE_MAX_BYTES,
          `content must be at most ${TRIAGE_NEW_FILE_MAX_BYTES} UTF-8 bytes`,
        ),
        v.description(`Full file content, at most ${TRIAGE_NEW_FILE_MAX_BYTES} UTF-8 bytes.`),
      ),
    }),
    run: async ({ path, content }) => {
      const { fullPath, relativePath: rel } = await assertTriageWritablePath({
        root,
        path,
        mode: "create",
        implicatedPaths,
      });
      if (await stat(fullPath).catch(() => null)) {
        throw new AppError({
          domain: "triage",
          kind: "path_exists",
          message: "Path already exists",
          context: { path: rel },
        });
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
      return { ok: true, path: rel };
    },
  });

  const commitFix = defineLocalTool({
    description:
      "Commit the fix for one inventory finding. Each finding gets at most one commit, so finish and check the edits for that finding first. It returns the commit sha, which a fixed verdict in submitTriage cites, and the committed diff, so you can confirm the commit holds what you intended. Staged files must be the finding's implicated files or files createWorkspaceFile allows.",
    schema: v.object({
      threadRootCommentId: v.pipe(
        v.number(),
        v.integer(),
        v.gtValue(0),
        v.description("Root comment id of the inventory thread this commit fixes."),
      ),
      files: v.pipe(
        v.array(repoPathParam),
        v.minLength(1),
        v.description("Every file this fix changed or created."),
      ),
      subject: v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Commit subject line describing the fix."),
      ),
      body: v.optional(
        v.pipe(
          v.array(v.pipe(v.string(), v.minLength(1))),
          v.maxLength(TRIAGE_COMMIT_BODY_MAX_BULLETS),
          v.description("Optional commit body bullets, one line each."),
        ),
      ),
    }),
    run: async ({ threadRootCommentId, files, subject, body }) => {
      if (!inventoryIds.has(threadRootCommentId)) {
        throw new AppError({
          domain: "triage",
          kind: "unknown_thread",
          message: "Unknown threadRootCommentId",
          context: { threadRootCommentId },
        });
      }
      if (params.state.commitByThreadRootCommentId.has(threadRootCommentId)) {
        throw new AppError({
          domain: "triage",
          kind: "commit_fix_duplicate",
          message: "commitFix already called for this threadRootCommentId",
          context: { threadRootCommentId },
        });
      }
      if (params.state.commitByThreadRootCommentId.size >= MAX_TRIAGE_FIXES_PER_RUN) {
        throw new AppError({
          domain: "triage",
          kind: "fix_budget_reached",
          message: "Triage fix budget reached",
        });
      }
      const staged = await assertTriageStagePaths({
        root,
        files,
        implicatedPaths,
      });
      try {
        const result = await params.checkout.commit({ files: [...staged], subject, body });
        params.state.commitByThreadRootCommentId.set(threadRootCommentId, result.sha);
        return result;
      } catch (error) {
        const message = errorMessage(error);
        params.state.commitErrors.push({ threadRootCommentId, error: message });
        throw error;
      }
    },
  });

  const tools = {
    editWorkspaceFile,
    createWorkspaceFile,
    commitFix,
  };

  const reads = buildWorkspaceTools({ profile: "triage", reader: params.checkout.reader });
  const writes = defineToolset(tools, "sequential");
  return {
    piTools: [...reads.piTools, ...writes.piTools],
    executors: { ...reads.executors, ...writes.executors },
  };
}
