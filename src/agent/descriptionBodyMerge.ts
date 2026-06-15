import { DESCRIPTION_AGENT_HEADER, DESCRIPTION_BODY_SEPARATOR } from "../settings.js";

export function mergeDescriptionIntoPrBody(params: {
  currentBody: string | null | undefined;
  agentBlock: string;
}): string {
  const agentBlock = params.agentBlock.trim();
  const current = (params.currentBody ?? "").trim();

  if (!current) {
    return agentBlock;
  }

  const headerIndex = current.indexOf(DESCRIPTION_AGENT_HEADER);
  if (headerIndex >= 0) {
    const userPart = current.slice(0, headerIndex).trimEnd();
    if (!userPart) return agentBlock;
    return `${userPart}${DESCRIPTION_BODY_SEPARATOR}${agentBlock}`;
  }

  return `${current}${DESCRIPTION_BODY_SEPARATOR}${agentBlock}`;
}
