const SECRET_RE =
  /(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*["']?([^\s"',}]+)/gi;

/** Redact secret-shaped substrings from log fields. */
export function redact(value: string): string {
  return value.replace(SECRET_RE, (match, secret: string) => {
    const prefix = match.slice(0, match.length - secret.length);
    return `${prefix}[REDACTED]`;
  });
}

export type AccessLog = {
  readonly level: "info";
  readonly msg: "access";
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly duration_ms: number;
  readonly request_id: string;
};

export function logAccess(entry: AccessLog): void {
  const line = {
    ...entry,
    path: redact(entry.path),
  };
  console.log(JSON.stringify(line));
}

export function newRequestId(incoming: string | null): string {
  if (incoming && incoming.trim()) return incoming.trim().slice(0, 128);
  return crypto.randomUUID();
}
