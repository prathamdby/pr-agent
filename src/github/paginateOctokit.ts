export type PaginatedOctokitResult<T> = {
  readonly items: T[];
  readonly truncated: boolean;
};

export async function paginateOctokitPagesWithMeta<T>(options: {
  perPage: number;
  maxPages?: number;
  fetchPage: (page: number, perPage: number) => Promise<readonly T[]>;
}): Promise<PaginatedOctokitResult<T>> {
  const results: T[] = [];
  let page = 1;

  for (;;) {
    const data = await options.fetchPage(page, options.perPage);
    if (data.length === 0) break;
    results.push(...data);
    if (data.length < options.perPage) break;
    if (options.maxPages != null && page >= options.maxPages) {
      return { items: results, truncated: true };
    }
    page++;
  }

  return { items: results, truncated: false };
}

export async function paginateOctokitPages<T>(options: {
  perPage: number;
  maxPages?: number;
  fetchPage: (page: number, perPage: number) => Promise<readonly T[]>;
}): Promise<T[]> {
  return (await paginateOctokitPagesWithMeta(options)).items;
}
