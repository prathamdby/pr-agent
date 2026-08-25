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

const headerGapCharacter =
  "(?:[^\\S\\r\\n\\u2028\\u2029]|\\p{Cf}|[\\x00-\\x09\\x0B\\x0C\\x0E-\\x1F\\x7F-\\x9F])";
const headerLetterGap = `${headerGapCharacter}*`;
const headerWordGap = `${headerGapCharacter}+`;

function headerWordPattern(word: string): string {
  return word.split("").join(headerLetterGap);
}

function neutralizeForgedTrustHeaders(text: string): string {
  const contextTagsNeutralized = neutralizeUntrustedBlockTags("context", text);
  const trustedContextPattern = new RegExp(
    `^${headerLetterGap}(?:#{1,6}${headerLetterGap})?${headerWordPattern("trusted")}${headerWordGap}${headerWordPattern("context")}\\b[^\\r\\n\\u2028\\u2029]*$`,
    "gimu",
  );
  const bindingLinePattern = new RegExp(
    `^${headerLetterGap}${headerWordPattern("these")}${headerWordGap}(?:${headerWordPattern("root")}${headerWordGap})?${headerWordPattern("files")}${headerWordGap}[^\\r\\n\\u2028\\u2029]*\\b${headerWordPattern("binding")}\\b[^\\r\\n\\u2028\\u2029]*$`,
    "gimu",
  );
  return contextTagsNeutralized
    .replace(trustedContextPattern, "[neutralized forged trusted header]")
    .replace(bindingLinePattern, "[neutralized forged binding line]");
}

function neutralizeUntrustedContent(label: string, text: string): string {
  return neutralizeForgedTrustHeaders(
    neutralizeEvidenceDelimiters(neutralizeUntrustedBlockTags(label, text)),
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
  return wrapUntrustedBlock("untrusted_evidence", `Source: ${safeSource}\n${text}`);
}

export function wrapTrustedContext(lines: string[]): string {
  return ['<context trusted="server">', ...lines, "</context>"].join("\n");
}

function escapeUntrustedReplyText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatReplyBlock(label: string, reply: string, index: number): string[] {
  return [
    `  ${label} ${index + 1}:`,
    wrapUntrustedBlock("maintainer_reply", escapeUntrustedReplyText(reply))
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  ];
}

export function formatHumanReplies(thread: {
  readonly humanReplies: readonly string[];
  readonly authorizedReplies?: readonly string[];
  readonly untrustedReplies?: readonly string[];
}): string[] {
  // Keep hand-built prompt fixtures useful while production data always carries
  // explicit authorized and untrusted partitions from the server.
  if (thread.authorizedReplies == null && thread.untrustedReplies == null) {
    return thread.humanReplies.flatMap((reply, index) =>
      formatReplyBlock("Maintainer reply", reply, index),
    );
  }

  return [
    ...(thread.authorizedReplies ?? []).flatMap((reply, index) =>
      formatReplyBlock("Authorized maintainer decision evidence", reply, index),
    ),
    ...(thread.untrustedReplies ?? []).flatMap((reply, index) =>
      formatReplyBlock("Untrusted commenter evidence", reply, index),
    ),
  ];
}
