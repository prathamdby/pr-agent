import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { logWarn } from "../evlog.js";
import {
  AGENT_INSTRUCTION_FILENAMES,
  MAX_AGENT_INSTRUCTION_BYTES,
  MAX_AGENT_INSTRUCTION_FILE_BYTES,
} from "../settings/index.js";

export type AgentInstructionFilename = (typeof AGENT_INSTRUCTION_FILENAMES)[number];

export type AgentInstructionFile = {
  readonly filename: AgentInstructionFilename;
  readonly body: string;
};

export type AgentInstructionFilesResult =
  | { kind: "absent" }
  | { kind: "ok"; files: readonly AgentInstructionFile[] };

function errnoCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export async function loadAgentInstructionFiles(
  checkoutRoot: string,
  maxBytes: number = MAX_AGENT_INSTRUCTION_BYTES,
): Promise<AgentInstructionFilesResult> {
  const files: AgentInstructionFile[] = [];
  let aggregateBytes = 0;

  for (const filename of AGENT_INSTRUCTION_FILENAMES) {
    const absolutePath = join(checkoutRoot, filename);
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      const message = error instanceof Error ? error.message : String(error);
      logWarn("agent_instruction_file_skipped", { path: absolutePath, reason: message });
      continue;
    }

    if (!fileStat.isFile()) {
      logWarn("agent_instruction_file_skipped", {
        path: absolutePath,
        reason: "not a regular file",
      });
      continue;
    }

    if (fileStat.size > MAX_AGENT_INSTRUCTION_FILE_BYTES) {
      logWarn("agent_instruction_file_skipped", {
        path: absolutePath,
        reason: "file exceeds size cap",
      });
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(absolutePath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn("agent_instruction_file_skipped", { path: absolutePath, reason: message });
      continue;
    }

    const body = raw.trim();
    if (body.length === 0) {
      logWarn("agent_instruction_file_skipped", {
        path: absolutePath,
        reason: "empty after trim",
      });
      continue;
    }

    const byteLength = Buffer.byteLength(body, "utf8");
    if (byteLength > MAX_AGENT_INSTRUCTION_FILE_BYTES) {
      logWarn("agent_instruction_file_skipped", {
        path: absolutePath,
        reason: "file exceeds size cap",
      });
      continue;
    }
    if (aggregateBytes + byteLength > maxBytes) {
      logWarn("agent_instruction_file_skipped", {
        path: absolutePath,
        reason: "aggregate size cap exceeded",
      });
      break;
    }

    aggregateBytes += byteLength;
    files.push({ filename, body });
  }

  if (files.length === 0) {
    return { kind: "absent" };
  }
  return { kind: "ok", files };
}

export function renderAgentInstructionFilesBlock(params: {
  readonly files: readonly AgentInstructionFile[];
}): string {
  if (params.files.length === 0) {
    return "";
  }

  const lines = [
    "Trusted context (agent instruction files):",
    "These root files are binding for this review. Flag evidenced violations as findings (lens reporting gate still applies).",
  ];

  for (const file of params.files) {
    lines.push("", `### File \`${file.filename}\``, file.body);
  }

  return lines.join("\n");
}
