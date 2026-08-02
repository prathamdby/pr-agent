import { describe, expect, it } from "vitest";
import { createHealthResponse, HEALTH_BODY } from "./health";

describe("GET /health", () => {
  it("returns JSON status ok with no-store", async () => {
    const res = createHealthResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual(HEALTH_BODY);
  });
});
