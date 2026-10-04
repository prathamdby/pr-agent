import { describe, expect, it } from "vitest";
import { parseInstallationPermissions } from "../src/github/installationCapabilities.js";

// Permission parsing failure modes:
// - an own `__proto__`, `constructor`, or `prototype` key reaches the grant record;
// - an `admin` grant on a permission that backs an operation is treated as write;
// - a grant outside read/write/admin, or a non-object payload, is accepted.
describe("parseInstallationPermissions", () => {
  // JSON.parse creates own keys; a valid grant value isolates the key guard.
  it.each(["__proto__", "constructor", "prototype"])(
    "rejects a payload with an own %s key",
    (key) => {
      const payload: unknown = JSON.parse(`{"${key}":"write","contents":"read"}`);
      expect(Object.keys(payload as object)).toContain(key);
      expect(parseInstallationPermissions(payload)).toBeUndefined();
    },
  );

  it.each(["pull_requests", "contents", "issues", "checks", "statuses"])(
    "rejects admin on the operation-backing %s permission",
    (permission) => {
      expect(parseInstallationPermissions({ [permission]: "admin" })).toBeUndefined();
    },
  );

  it("keeps admin on a permission that backs no operation", () => {
    expect(parseInstallationPermissions({ administration: "admin", contents: "read" })).toEqual({
      administration: "admin",
      contents: "read",
    });
  });

  it.each([["none"], [""], [null], [1], [true], [{ level: "write" }]])(
    "rejects the grant value %j",
    (grant) => {
      expect(parseInstallationPermissions({ contents: grant })).toBeUndefined();
    },
  );

  it.each([[null], [undefined], ["read"], [1], [[["contents", "read"]]]])(
    "rejects the non-record payload %j",
    (value) => {
      expect(parseInstallationPermissions(value)).toBeUndefined();
    },
  );

  it("returns read and write grants unchanged", () => {
    expect(
      parseInstallationPermissions({ contents: "read", pull_requests: "write", metadata: "read" }),
    ).toEqual({ contents: "read", pull_requests: "write", metadata: "read" });
  });
});
