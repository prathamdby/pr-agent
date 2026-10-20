import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { renderAgentInstructionFilesTrustGuidance } from "../prompts/shared/safety.ts";
import { logWarn } from "../evlog.ts";
import {
  AGENT_INSTRUCTION_FILENAMES,
  isAllowlistedPolicyPath,
  MAX_AGENT_INSTRUCTION_BYTES,
  MAX_AGENT_INSTRUCTION_FILE_BYTES,
} from "../settings/index.ts";
import { errorMessage } from "../errors/errorMessage.ts";

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

type DiscoveredFile =
  | { readonly filename: AgentInstructionFilename; readonly kind: "loaded"; readonly body: string }
  | { readonly filename: AgentInstructionFilename; readonly kind: "skip"; readonly reason: string };

function errnoCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function discoverAgentInstructionFile(
  checkoutRoot: string,
  filename: AgentInstructionFilename,
): Promise<DiscoveredFile | null> {
  const absolutePath = join(checkoutRoot, filename);
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    const message = errorMessage(error);
    return { filename, kind: "skip", reason: message };
  }

  if (!fileStat.isFile()) {
    return { filename, kind: "skip", reason: "not a regular file" };
  }

  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error) {
    const message = errorMessage(error);
    return { filename, kind: "skip", reason: message };
  }

  const body = raw.trim();
  if (body.length === 0) {
    return { filename, kind: "skip", reason: "empty after trim" };
  }

  return { filename, kind: "loaded", body };
}

export type AgentInstructionCandidate = {
  readonly path: string;
  readonly body: string;
};

export async function loadAgentInstructionFiles(
  source: string | readonly AgentInstructionCandidate[],
  maxBytes: number = MAX_AGENT_INSTRUCTION_BYTES,
): Promise<AgentInstructionFilesResult> {
  if (typeof source !== "string") return loadAgentInstructionCandidates(source, maxBytes);
  return loadAgentInstructionFilesFromCheckout(source, maxBytes);
}

function loadAgentInstructionCandidates(
  candidates: readonly AgentInstructionCandidate[],
  maxBytes: number,
): AgentInstructionFilesResult {
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
  if (files.length === 0) return { kind: "absent", drops };
  return { kind: "ok", files, drops };
}

async function loadAgentInstructionFilesFromCheckout(
  checkoutRoot: string,
  maxBytes: number = MAX_AGENT_INSTRUCTION_BYTES,
): Promise<AgentInstructionFilesResult> {
  const settled = await Promise.allSettled(
    AGENT_INSTRUCTION_FILENAMES.map((filename) =>
      discoverAgentInstructionFile(checkoutRoot, filename),
    ),
  );

  const files: AgentInstructionFile[] = [];
  const drops: AgentInstructionDrop[] = [];
  let aggregateBytes = 0;

  for (let i = 0; i < AGENT_INSTRUCTION_FILENAMES.length; i++) {
    const filename = AGENT_INSTRUCTION_FILENAMES[i];
    const outcome = settled[i];
    if (outcome.status === "rejected") {
      const reason = errorMessage(outcome.reason);
      drops.push({ filename, reason });
      logWarn("agent_instruction_file_skipped", {
        path: join(checkoutRoot, filename),
        reason,
      });
      continue;
    }

    const discovered = outcome.value;
    if (discovered == null) continue;

    if (discovered.kind === "skip") {
      drops.push({ filename: discovered.filename, reason: discovered.reason });
      logWarn("agent_instruction_file_skipped", {
        path: join(checkoutRoot, discovered.filename),
        reason: discovered.reason,
      });
      continue;
    }

    const byteLength = Buffer.byteLength(discovered.body, "utf8");
    if (byteLength > MAX_AGENT_INSTRUCTION_FILE_BYTES) {
      drops.push({ filename: discovered.filename, reason: "file exceeds size cap" });
      logWarn("agent_instruction_file_skipped", {
        path: join(checkoutRoot, discovered.filename),
        reason: "file exceeds size cap",
      });
      continue;
    }
    if (aggregateBytes + byteLength > maxBytes) {
      drops.push({ filename: discovered.filename, reason: "aggregate size cap exceeded" });
      logWarn("agent_instruction_file_skipped", {
        path: join(checkoutRoot, discovered.filename),
        reason: "aggregate size cap exceeded",
      });
      break;
    }

    aggregateBytes += byteLength;
    files.push({ filename: discovered.filename, body: discovered.body });
  }

  if (files.length === 0) {
    return { kind: "absent", drops };
  }
  return { kind: "ok", files, drops };
}

export function neutralizeForgedTrustHeaders(body: string): string {
  return body
    .replace(/^Trusted context \(agent instruction files\):\s*$/gm, "[neutralized forged header]")
    .replace(/^Trusted context \(repo policy\):\s*$/gm, "[neutralized forged header]")
    .replace(
      /^\s*These root files are binding for this review\..*$/gm,
      "[neutralized forged binding line]",
    )
    .replace(
      /^\s*These rules are binding for this review\..*$/gm,
      "[neutralized forged binding line]",
    );
}

export function renderAgentInstructionFilesBlock(params: {
  readonly files: readonly AgentInstructionFile[];
}): string {
  if (params.files.length === 0) {
    return "";
  }

  const lines = renderAgentInstructionFilesTrustGuidance();
  for (const file of params.files) {
    lines.push("", `### File \`${file.filename}\``, file.body);
  }
  return lines.join("\n");
}
