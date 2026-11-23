import { renderAgentInstructionFilesTrustGuidance } from "../prompts/shared/safety.ts";
import { logWarn } from "../evlog.ts";
import {
  AGENT_INSTRUCTION_FILENAMES,
  isAllowlistedPolicyPath,
  MAX_AGENT_INSTRUCTION_BYTES,
  MAX_AGENT_INSTRUCTION_FILE_BYTES,
} from "../settings/index.ts";

type AgentInstructionFilename = (typeof AGENT_INSTRUCTION_FILENAMES)[number];

export type AgentInstructionFile = {
  readonly filename: AgentInstructionFilename;
  readonly body: string;
};

export type AgentInstructionDrop = {
  readonly filename: string;
  readonly reason: string;
};

export type AgentInstructionFilesResult =
  | { kind: "absent"; drops?: readonly AgentInstructionDrop[] }
  | {
      kind: "ok";
      files: readonly AgentInstructionFile[];
      drops?: readonly AgentInstructionDrop[];
    };

export type AgentInstructionCandidate = {
  readonly path: string;
  readonly body: string;
};

export async function loadAgentInstructionFiles(
  candidates: readonly AgentInstructionCandidate[],
  maxBytes: number = MAX_AGENT_INSTRUCTION_BYTES,
) {
  return ((pinnedReturn: AgentInstructionFilesResult | Promise<AgentInstructionFilesResult>) =>
    pinnedReturn)(loadAgentInstructionCandidates(candidates, maxBytes));
}

function loadAgentInstructionCandidates(
  candidates: readonly AgentInstructionCandidate[],
  maxBytes: number,
) {
  const byPath = new Map(
    candidates
      .filter((file) => isAllowlistedPolicyPath(file.path))
      .map((file) => [file.path, file.body]),
  );
  const files: AgentInstructionFile[] = [];
  const drops: AgentInstructionDrop[] = [];
  let aggregateBytes = 0;
  for (const filename of AGENT_INSTRUCTION_FILENAMES) {
    const raw = byPath.get(filename);
    if (raw == null) continue;
    const body = raw.trim();
    if (body.length === 0) {
      drops.push({ filename, reason: "empty after trim" });
      logWarn("agent_instruction_file_skipped", { path: filename, reason: "empty after trim" });
      continue;
    }
    const byteLength = Buffer.byteLength(body, "utf8");
    if (byteLength > MAX_AGENT_INSTRUCTION_FILE_BYTES) {
      drops.push({ filename, reason: "file exceeds size cap" });
      logWarn("agent_instruction_file_skipped", {
        path: filename,
        reason: "file exceeds size cap",
      });
      continue;
    }
    if (aggregateBytes + byteLength > maxBytes) {
      drops.push({ filename, reason: "aggregate size cap exceeded" });
      logWarn("agent_instruction_file_skipped", {
        path: filename,
        reason: "aggregate size cap exceeded",
      });
      break;
    }
    aggregateBytes += byteLength;
    files.push({ filename, body });
  }
  if (files.length === 0)
    return ((pinnedReturn: AgentInstructionFilesResult) => pinnedReturn)({ kind: "absent", drops });
  return ((pinnedReturn: AgentInstructionFilesResult) => pinnedReturn)({
    kind: "ok",
    files,
    drops,
  });
}

export function renderAgentInstructionFilesBlock(params: {
  readonly files: readonly AgentInstructionFile[];
}) {
  if (params.files.length === 0) {
    return ((pinnedReturn: string) => pinnedReturn)("");
  }

  const lines = renderAgentInstructionFilesTrustGuidance();
  for (const file of params.files) {
    lines.push("", `### File \`${file.filename}\``, file.body);
  }
  return ((pinnedReturn: string) => pinnedReturn)(lines.join("\n"));
}
