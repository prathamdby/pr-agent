/**
 * Extract the question from `/ask ...` on the first non-empty line.
 * Supports optional surrounding quotes on the question text.
 */
export function parseAskQuestion(body: string): string | null {
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

	return rest.length > 0 ? rest : null;
}

export const ASK_USAGE_HINT = "Usage: `/ask <your question>` — ask about this PR or a specific line of code.";
