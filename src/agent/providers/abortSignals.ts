export function combineAbortSignals(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const defined = signals.filter((signal): signal is AbortSignal => signal != null);
  if (defined.length === 0) return new AbortController().signal;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

export function idleAbortSignal(): AbortSignal {
  return new AbortController().signal;
}
