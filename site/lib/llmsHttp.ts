import {
  answerAgentQuery,
  parseAgentQuery,
  renderAnswerJson,
  renderAnswerText,
  renderLlmsTxt,
} from "./llmsKnowledge.js";

const TEXT_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "public, max-age=300",
  "X-Content-Type-Options": "nosniff",
} as const;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=300",
  "X-Content-Type-Options": "nosniff",
} as const;

export function llmsTxtResponse(): Response {
  return new Response(renderLlmsTxt(), { headers: TEXT_HEADERS });
}

export function llmsQueryResponse(request: Request, format: "text" | "json"): Response {
  const url = new URL(request.url);
  const raw = url.searchParams.get("query") ?? "";
  const answer = answerAgentQuery(parseAgentQuery(raw));
  switch (format) {
    case "text":
      return new Response(renderAnswerText(answer), { headers: TEXT_HEADERS });
    case "json":
      return Response.json(renderAnswerJson(answer), { headers: JSON_HEADERS });
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}
