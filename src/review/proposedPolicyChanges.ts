import { wrapUntrustedBlock } from "../prompts/shared/safety.ts";
import type { LocalPrChangedFile } from "../prWorkspace/repositoryReader.ts";
import {
  isAllowlistedPolicyPath,
  MAX_AGENT_INSTRUCTION_FILE_BYTES,
  MAX_REPO_POLICY_FILE_BYTES,
  REPO_POLICY_EXTENSION,
} from "../settings/index.ts";

function neutralizeProposedPolicyBody(body: string): string {
  return body
    .replace(/Trusted context \(repo policy\):/gi, "[neutralized forged header]")
    .replace(/Trusted context \(agent instruction files\):/gi, "[neutralized forged header]")
    .replace(
      /^\s*These rules are binding for this review\..*$/gim,
      "[neutralized forged binding line]",
    )
    .replace(
      /^\s*These root files are binding for this review\..*$/gim,
      "[neutralized forged binding line]",
    );
}

export type PolicyChangeSide = {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "other";
};

export function allowlistedPolicyChangeSides(
  changedFiles: readonly LocalPrChangedFile[],
): PolicyChangeSide[] {
  const sides: PolicyChangeSide[] = [];
  for (const file of changedFiles) {
    if (file.status === "renamed") {
      if (file.oldPath != null && isAllowlistedPolicyPath(file.oldPath)) {
        sides.push({ path: file.oldPath, status: "deleted" });
      }
      if (isAllowlistedPolicyPath(file.path)) sides.push({ path: file.path, status: "added" });
      continue;
    }
    if (file.status === "copied") {
      if (isAllowlistedPolicyPath(file.path)) sides.push({ path: file.path, status: "added" });
      continue;
    }
    if (
      (file.status === "added" ||
        file.status === "modified" ||
        file.status === "deleted" ||
        file.status === "other") &&
      isAllowlistedPolicyPath(file.path)
    ) {
      sides.push({ path: file.path, status: file.status });
    }
  }
  return sides;
}

function capFor(path: string): number {
  return path.endsWith(REPO_POLICY_EXTENSION)
    ? MAX_REPO_POLICY_FILE_BYTES
    : MAX_AGENT_INSTRUCTION_FILE_BYTES;
}

export async function renderProposedPolicyChanges(params: {
  readonly changedFiles: readonly LocalPrChangedFile[];
  readonly readHead: (path: string, maxFileBytes: number) => Promise<string | null>;
}): Promise<string> {
  const blocks: string[] = [];
  for (const side of allowlistedPolicyChangeSides(params.changedFiles)) {
    const lines = [`Proposed policy change (${side.status}) \`${side.path}\`:`];
    if (side.status !== "deleted") {
      const body = await params.readHead(side.path, capFor(side.path));
      if (body != null) {
        const policyFile = side.path.endsWith(REPO_POLICY_EXTENSION);
        lines.push(
          wrapUntrustedBlock(
            policyFile ? "proposed_policy_change" : "proposed_agent_instruction",
            neutralizeProposedPolicyBody(body),
          ),
        );
      }
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
