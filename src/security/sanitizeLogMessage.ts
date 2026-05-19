const MAX_LOG_MESSAGE_LEN = 2_000;

export function sanitizeLogMessage(raw: string): string {
	return raw
		.replace(/\0/g, "")
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/(token|password|secret|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=[redacted]")
		.replace(/\b[Aa]uthorization\s*:\s*.+/gi, "Authorization: [redacted]")
		.slice(0, MAX_LOG_MESSAGE_LEN);
}
