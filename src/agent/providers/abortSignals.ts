export function combineAbortSignals(signals: ReadonlyArray<AbortSignal | undefined>) {
  const defined = signals.filter((signal): signal is AbortSignal => signal != null);
  if (defined.length === 0)
    return ((pinnedReturn: AbortSignal) => pinnedReturn)(new AbortController().signal);
  if (defined.length === 1) return ((pinnedReturn: AbortSignal) => pinnedReturn)(defined[0]);
  return ((pinnedReturn: AbortSignal) => pinnedReturn)(AbortSignal.any(defined));
}

export function idleAbortSignal() {
  return ((pinnedReturn: AbortSignal) => pinnedReturn)(new AbortController().signal);
}
