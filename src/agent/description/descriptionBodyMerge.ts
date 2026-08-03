import {
  DESCRIPTION_AGENT_BODY_BEGIN,
  DESCRIPTION_AGENT_BODY_END,
  DESCRIPTION_AGENT_HEADER,
} from "../../settings/index.js";

export function wrapDescriptionAgentBlock(agentBlock: string): string {
  const trimmed = agentBlock.trim();
  return `${DESCRIPTION_AGENT_BODY_BEGIN}\n${trimmed}\n${DESCRIPTION_AGENT_BODY_END}`;
}

export function extractUserAuthoredPrBody(body: string | null | undefined): string {
  const current = body ?? "";
  const beginIndex = current.indexOf(DESCRIPTION_AGENT_BODY_BEGIN);
  if (beginIndex >= 0) {
    const endIndex = current.indexOf(DESCRIPTION_AGENT_BODY_END, beginIndex);
    const before = current.slice(0, beginIndex).trimEnd();
    const after =
      endIndex >= 0 ? current.slice(endIndex + DESCRIPTION_AGENT_BODY_END.length).trimStart() : "";
    return [before, after]
      .filter((part) => part.length > 0)
      .join("\n\n")
      .trim();
  }

  const headerIndex = current.indexOf(DESCRIPTION_AGENT_HEADER);
  if (headerIndex >= 0) {
    return current.slice(0, headerIndex).trimEnd();
  }

  return current.trim();
}

export function prBodyHasAgentDescriptionBlock(body: string | null | undefined): boolean {
  const current = body ?? "";
  if (current.includes(DESCRIPTION_AGENT_BODY_BEGIN)) return true;
  return current.includes(DESCRIPTION_AGENT_HEADER);
}

export function extractAgentDescriptionBlock(body: string | null | undefined): string | null {
  const current = body ?? "";
  const beginIndex = current.indexOf(DESCRIPTION_AGENT_BODY_BEGIN);
  if (beginIndex >= 0) {
    const contentStart = beginIndex + DESCRIPTION_AGENT_BODY_BEGIN.length;
    const endIndex = current.indexOf(DESCRIPTION_AGENT_BODY_END, contentStart);
    if (endIndex < 0) return current.slice(contentStart).trim() || null;
    return current.slice(contentStart, endIndex).trim() || null;
  }

  const headerIndex = current.indexOf(DESCRIPTION_AGENT_HEADER);
  if (headerIndex < 0) return null;
  return current.slice(headerIndex).trim() || null;
}

export function mergeDescriptionIntoPrBody(params: {
  currentBody: string | null | undefined;
  agentBlock: string;
}): string {
  const wrappedAgentBlock = wrapDescriptionAgentBlock(params.agentBlock);
  const userPart = extractUserAuthoredPrBody(params.currentBody);
  if (!userPart) return wrappedAgentBlock;
  return `${userPart}\n\n${wrappedAgentBlock}`;
}
