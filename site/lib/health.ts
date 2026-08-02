/** Shared liveness payload for GET /health. */
export const HEALTH_BODY = { status: "ok" } as const;

export function createHealthResponse(): Response {
  return new Response(JSON.stringify(HEALTH_BODY), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
