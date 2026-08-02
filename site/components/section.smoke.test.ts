import { describe, expect, it } from "vitest";
import { Section } from "./section";

describe("Section component", () => {
  it("is a function component", () => {
    expect(typeof Section).toBe("function");
  });
});
