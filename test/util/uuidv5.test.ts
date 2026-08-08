import { describe, expect, it } from "vitest";
import { uuidv5 } from "../../src/util/uuidv5.js";

// RFC 4122 appendix B / DNS namespace vectors.
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("uuidv5", () => {
  it("matches the DNS/www.example.com vector", () => {
    expect(uuidv5(DNS_NAMESPACE, "www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("is deterministic for the same namespace and name", () => {
    const a = uuidv5("3f2504e0-4f89-11d3-9a0c-0305e82c3301", "ci-refresh:7");
    const b = uuidv5("3f2504e0-4f89-11d3-9a0c-0305e82c3301", "ci-refresh:7");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
