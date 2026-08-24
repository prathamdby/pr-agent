function neutralizeUntrustedBlockTags(label: string, text: string): string {
  const tagGap = "[\\s\\p{Cf}\\p{Cc}]*";
  const labelPattern = label
    .split("")
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(tagGap);
  const tagPattern = new RegExp(
    `<${tagGap}/?${tagGap}${labelPattern}(?=[\\s>/\\p{Cf}\\p{Cc}])[^>]*>`,
    "giu",
  );
  return text.replace(tagPattern, (tag) => tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
}

function neutralizeForgedTrustHeaders(text: string): string {
  const contextTagsNeutralized = neutralizeUntrustedBlockTags("context", text);
  return contextTagsNeutralized
    .replace(
      /^[ \t]*(?:#{1,6}[ \t]*)?trusted[ \t]+context\b[^\r\n]*$/gimu,
      "[neutralized forged trusted header]",
    )
    .replace(
      /^[ \t]*these[ \t]+(?:root[ \t]+)?files[^\r\n]*\bbinding\b[^\r\n]*$/gimu,
      "[neutralized forged binding line]",
    );
}

function neutralizeUntrustedContent(label: string, text: string): string {
  return neutralizeForgedTrustHeaders(neutralizeUntrustedBlockTags(label, text));
}

const serverOwnedEvidenceLabels = [
  "untrusted_evidence",
  "context",
  "specialist_report",
  "accepted_placements",
  "partial_specialists",
  "specialist_outcomes",
] as const;

function neutralizeEvidenceDelimiters(text: string): string {
  return serverOwnedEvidenceLabels.reduce(
    (current, label) => neutralizeUntrustedBlockTags(label, current),
    text,
  );
}

export function wrapUntrustedBlock(label: string, text: string): string {
  return [
    `<${label} untrusted="true">`,
    neutralizeUntrustedContent(label, text.trim()),
    `</${label}>`,
  ].join("\n");
}

/**
 * Wrap model-visible repository, PR, and external-tool content as evidence.
 * The source label is server-owned metadata; the enclosed text is not an instruction.
 */
export function wrapUntrustedEvidence(source: string, text: string): string {
  const safeSource = source.replace(/[\r\n]+/g, " ").trim() || "unknown";
  return wrapUntrustedBlock(
    "untrusted_evidence",
    neutralizeEvidenceDelimiters(`Source: ${safeSource}\n${text}`),
  );
}

export function wrapTrustedContext(lines: string[]): string {
  return ['<context trusted="server">', ...lines, "</context>"].join("\n");
}

export function formatHumanReplies(thread: { readonly humanReplies: readonly string[] }): string[] {
  return thread.humanReplies.flatMap((reply, index) => [
    `  Maintainer reply ${index + 1}:`,
    wrapUntrustedBlock("maintainer_reply", reply)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  ]);
}
