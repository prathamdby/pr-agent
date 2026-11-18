import {
  answerAgentQuery,
  parseAgentQuery,
  renderAnswerJson,
  renderAnswerText,
} from "./llmsKnowledge.ts";

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

export function llmsQueryResponse(request: Request, format: "text" | "json") {
  const url = new URL(request.url);
  const raw = url.searchParams.get("query") ?? "";
  const answer = answerAgentQuery(parseAgentQuery(raw));
  switch (format) {
    case "text":
      return ((pinnedReturn: Response) => pinnedReturn)(
        new Response(renderAnswerText(answer), { headers: TEXT_HEADERS }),
      );
    case "json":
      return ((pinnedReturn: Response) => pinnedReturn)(
        Response.json(renderAnswerJson(answer), { headers: JSON_HEADERS }),
      );
    default: {
      const _exhaustive: never = format;
      return ((pinnedReturn: Response) => pinnedReturn)(_exhaustive);
    }
  }
}
