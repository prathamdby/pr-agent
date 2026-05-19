import { MAX_ASK_QUESTION_CHARS } from "../agent/askSafety.js";

/**
 * Extract the question from `/ask ...` on the first non-empty line.
 * Supports optional surrounding quotes on the question text.
 */
function askRestFromBody(body: string): string | null {
	const lines = body.split(/\r?\n/);
	const first = lines.find((l) => l.trim().length > 0) ?? "";
	const m = first.match(/^\/ask(?:\s+(.*))?$/);
	if (!m) return null;

	let rest = (m[1] ?? "").trim();
	if (
		(rest.startsWith('"') && rest.endsWith('"')) ||
		(rest.startsWith("'") && rest.endsWith("'"))
	) {
		rest = rest.slice(1, -1).trim();
	}
	return rest;
}

export function parseAskQuestion(body: string): string | null {
	const rest = askRestFromBody(body);
	if (rest == null || rest.length === 0 || rest.length > MAX_ASK_QUESTION_CHARS) return null;
	return rest;
}

export function askQuestionParseFailure(body: string): "missing" | "too_long" | null {
	const rest = askRestFromBody(body);
	if (rest == null) return null;
	if (rest.length === 0) return "missing";
	if (rest.length > MAX_ASK_QUESTION_CHARS) return "too_long";
	return null;
}

export const ASK_USAGE_HINT = "Usage: `/ask <your question>` — ask about this PR or a specific line of code.";

export const ASK_QUESTION_TOO_LONG_HINT = `Your question exceeds the ${MAX_ASK_QUESTION_CHARS} character limit. Shorten it or reference files by path instead of pasting large blocks.`;
