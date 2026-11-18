export type PaginatedOctokitResult<T> = {
  readonly items: T[];
  readonly truncated: boolean;
};

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

export async function paginateOctokitPagesWithMeta<T>(options: {
  perPage: number;
  maxPages?: number;
  fetchPage: (page: number, perPage: number) => Promise<readonly T[]>;
}) {
  const results: T[] = [];
  let page = 1;

  for (;;) {
    const data = await options.fetchPage(page, options.perPage);
    if (data.length === 0) break;
    results.push(...data);
    if (data.length < options.perPage) break;
    if (options.maxPages != null && page >= options.maxPages) {
      return ((pinnedReturn: PaginatedOctokitResult<T> | Promise<PaginatedOctokitResult<T>>) =>
        pinnedReturn)({ items: results, truncated: true });
    }
    page++;
  }

  return ((pinnedReturn: PaginatedOctokitResult<T> | Promise<PaginatedOctokitResult<T>>) =>
    pinnedReturn)({ items: results, truncated: false });
}
