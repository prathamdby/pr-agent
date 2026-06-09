import { describe, expect, it } from "vitest";
import { compileIgnoreGlobs, isIgnoredReviewPath } from "../src/agent/ignoredPaths.js";

describe("isIgnoredReviewPath", () => {
  it("ignores GraphQL codegen __generated__ files at any depth", () => {
    expect(isIgnoredReviewPath("__generated__/types.ts")).toBe(true);
    expect(isIgnoredReviewPath("src/api/__generated__/operations.ts")).toBe(true);
  });

  it("ignores lockfiles, vendored deps, and build output", () => {
    expect(isIgnoredReviewPath("pnpm-lock.yaml")).toBe(true);
    expect(isIgnoredReviewPath("packages/app/package-lock.json")).toBe(true);
    expect(isIgnoredReviewPath("Cargo.lock")).toBe(true);
    expect(isIgnoredReviewPath("go.sum")).toBe(true);
    expect(isIgnoredReviewPath("vendor/github.com/x/y.go")).toBe(true);
    expect(isIgnoredReviewPath("node_modules/left-pad/index.js")).toBe(true);
    expect(isIgnoredReviewPath("dist/bundle.js")).toBe(true);
    expect(isIgnoredReviewPath("src/app.min.js")).toBe(true);
    expect(isIgnoredReviewPath("src/app.js.map")).toBe(true);
  });

  it("ignores generated, snapshot, and binary-asset files", () => {
    expect(isIgnoredReviewPath("api/schema.generated.ts")).toBe(true);
    expect(isIgnoredReviewPath("proto/user.pb.go")).toBe(true);
    expect(isIgnoredReviewPath("components/__snapshots__/Button.test.tsx.snap")).toBe(true);
    expect(isIgnoredReviewPath("public/logo.svg")).toBe(true);
    expect(isIgnoredReviewPath("assets/hero.PNG")).toBe(true);
  });

  it("keeps real source files", () => {
    expect(isIgnoredReviewPath("src/index.ts")).toBe(false);
    expect(isIgnoredReviewPath("src/review/reviewRun.ts")).toBe(false);
    expect(isIgnoredReviewPath("README.md")).toBe(false);
    expect(isIgnoredReviewPath("docs/configuration.md")).toBe(false);
    expect(isIgnoredReviewPath("src/components/Button.tsx")).toBe(false);
    expect(isIgnoredReviewPath("src/vendor/partner.ts")).toBe(false);
  });

  it("compileIgnoreGlobs expands braces into separate matchers", () => {
    const matchers = compileIgnoreGlobs(["**/*.{png,svg}"]);
    expect(matchers.length).toBe(2);
    expect(matchers.some((re) => re.test("a/b/c.png"))).toBe(true);
    expect(matchers.some((re) => re.test("a/b/c.svg"))).toBe(true);
  });
});
