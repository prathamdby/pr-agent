import {
  DESCRIPTION_AGENT_BODY_BEGIN,
  DESCRIPTION_AGENT_BODY_END,
  DESCRIPTION_AGENT_HEADER,
} from "../../settings/index.ts";

export function wrapDescriptionAgentBlock(agentBlock: string) {
  const trimmed = agentBlock.trim();
  return ((pinnedReturn: string) => pinnedReturn)(
    `${DESCRIPTION_AGENT_BODY_BEGIN}\n${trimmed}\n${DESCRIPTION_AGENT_BODY_END}`,
  );
}

export function extractUserAuthoredPrBody(body: string | null | undefined) {
  const current = body ?? "";
  const beginIndex = current.indexOf(DESCRIPTION_AGENT_BODY_BEGIN);
  if (beginIndex >= 0) {
    const endIndex = current.indexOf(DESCRIPTION_AGENT_BODY_END, beginIndex);
    const before = current.slice(0, beginIndex).trimEnd();
    const after =
      endIndex >= 0 ? current.slice(endIndex + DESCRIPTION_AGENT_BODY_END.length).trimStart() : "";
    return ((pinnedReturn: string) => pinnedReturn)(
      [before, after]
        .filter((part) => part.length > 0)
        .join("\n\n")
        .trim(),
    );
  }

  const headerIndex = current.indexOf(DESCRIPTION_AGENT_HEADER);
  if (headerIndex >= 0) {
    return ((pinnedReturn: string) => pinnedReturn)(current.slice(0, headerIndex).trimEnd());
  }

  return ((pinnedReturn: string) => pinnedReturn)(current.trim());
}

export function prBodyHasAgentDescriptionBlock(body: string | null | undefined) {
  const current = body ?? "";
  if (current.includes(DESCRIPTION_AGENT_BODY_BEGIN))
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  return ((pinnedReturn: boolean) => pinnedReturn)(current.includes(DESCRIPTION_AGENT_HEADER));
}

export function extractAgentDescriptionBlock(body: string | null | undefined) {
  const current = body ?? "";
  const beginIndex = current.indexOf(DESCRIPTION_AGENT_BODY_BEGIN);
  if (beginIndex >= 0) {
    const contentStart = beginIndex + DESCRIPTION_AGENT_BODY_BEGIN.length;
    const endIndex = current.indexOf(DESCRIPTION_AGENT_BODY_END, contentStart);
    if (endIndex < 0)
      return ((pinnedReturn: string | null) => pinnedReturn)(
        current.slice(contentStart).trim() || null,
      );
    return ((pinnedReturn: string | null) => pinnedReturn)(
      current.slice(contentStart, endIndex).trim() || null,
    );
  }

  const headerIndex = current.indexOf(DESCRIPTION_AGENT_HEADER);
  if (headerIndex < 0) return ((pinnedReturn: string | null) => pinnedReturn)(null);
  return ((pinnedReturn: string | null) => pinnedReturn)(current.slice(headerIndex).trim() || null);
}

export function mergeDescriptionIntoPrBody(params: {
  currentBody: string | null | undefined;
  agentBlock: string;
}) {
  const wrappedAgentBlock = wrapDescriptionAgentBlock(params.agentBlock);
  const userPart = extractUserAuthoredPrBody(params.currentBody);
  if (!userPart) return ((pinnedReturn: string) => pinnedReturn)(wrappedAgentBlock);
  return ((pinnedReturn: string) => pinnedReturn)(`${userPart}\n\n${wrappedAgentBlock}`);
}
