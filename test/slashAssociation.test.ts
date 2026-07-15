import { describe, expect, it } from "vitest";
import { isSlashAssociationAllowed } from "../src/commands/slashAssociation.js";

describe("isSlashAssociationAllowed", () => {
  it("allows any association when wildcard is configured", () => {
    expect(isSlashAssociationAllowed(new Set(["*"]), "NONE")).toBe(true);
    expect(isSlashAssociationAllowed(new Set(["*"]), null)).toBe(true);
  });

  it("matches configured associations case-insensitively", () => {
    const allowed = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
    expect(isSlashAssociationAllowed(allowed, "member")).toBe(true);
    expect(isSlashAssociationAllowed(allowed, "OWNER")).toBe(true);
    expect(isSlashAssociationAllowed(allowed, "NONE")).toBe(false);
    expect(isSlashAssociationAllowed(allowed, null)).toBe(false);
  });
});
