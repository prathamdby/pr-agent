export function stopPaginatedPage<T>(
  state: { page: number; truncated: boolean },
  data: readonly T[],
  perPage: number,
  maxPages: number | undefined,
  done: () => void,
) {
  state.page += 1;
  if (data.length === 0 || data.length < perPage) done();
  else if (maxPages != null && state.page >= maxPages) {
    state.truncated = true;
    done();
  }
  return ((pinnedReturn: T[]) => pinnedReturn)([...data]);
}
