export async function paginateOctokitPages<T>(options: {
  perPage: number;
  maxPages?: number;
  fetchPage: (page: number, perPage: number) => Promise<readonly T[]>;
}): Promise<T[]> {
  const results: T[] = [];
  let page = 1;

  for (;;) {
    const data = await options.fetchPage(page, options.perPage);
    if (data.length === 0) break;
    results.push(...data);
    if (data.length < options.perPage) break;
    if (options.maxPages != null && page >= options.maxPages) break;
    page++;
  }

  return results;
}
