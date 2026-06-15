import { vi } from "vitest";

export function paginateFromListReviews(_listReviews: ReturnType<typeof vi.fn>) {
  return vi.fn(async (route: (params: unknown) => Promise<{ data: unknown }>, params: unknown) => {
    const result = await route(params);
    return result.data;
  });
}

export function paginateFromListReviewComments(_listReviewComments: ReturnType<typeof vi.fn>) {
  return vi.fn(async (route: (params: unknown) => Promise<{ data: unknown }>, params: unknown) => {
    const result = await route(params);
    return result.data;
  });
}
