import { describe, expect, it } from "vitest";
import { LICENSE_URL, REPO_URL, SITE_ORIGIN } from "./site";

describe("site lib", () => {
  it("exposes repo and license URLs", () => {
    expect(REPO_URL).toContain("github.com");
    expect(LICENSE_URL).toContain("LICENSE");
    expect(SITE_ORIGIN.length).toBeGreaterThan(0);
  });
});
