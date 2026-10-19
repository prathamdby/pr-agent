import { describe, expect, it } from "vitest";
import { isSlashAssociationAllowed, reviewAuthorTrust } from "../src/commands/slashAssociation.ts";

describe("reviewAuthorTrust", () => {
  it.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "trusts fork authors with %s association",
    (author_association) => {
      expect(
        reviewAuthorTrust({
          author_association,
          head: { repo: { id: 2 } },
          base: { repo: { id: 1 } },
        }),
      ).toBe("trusted");
    },
  );
  it.each(["CONTRIBUTOR", "contributor"])(
    "holds a fork %s for maintainer approval",
    (author_association) => {
      expect(
        reviewAuthorTrust({
          author_association,
          head: { repo: { id: 2 } },
          base: { repo: { id: 1 } },
        }),
      ).toBe("awaiting_maintainer_approval");
    },
  );
  it.each(["NONE", "CONTRIBUTOR"])("trusts same-repo heads with %s", (author_association) => {
    expect(
      reviewAuthorTrust({
        author_association,
        head: { repo: { id: 1 } },
        base: { repo: { id: 1 } },
      }),
    ).toBe("trusted");
  });
  it.each([
    { author_association: undefined, head: { repo: { id: 1 } }, base: { repo: { id: 1 } } },
    { author_association: "OWNER", head: { repo: null }, base: { repo: { id: 1 } } },
    { author_association: "NONE", head: { repo: { id: 2 } }, base: { repo: { id: 1 } } },
    { author_association: "", head: { repo: { id: 2 } }, base: { repo: { id: 1 } } },
    {
      author_association: "FIRST_TIME_CONTRIBUTOR",
      head: { repo: { id: 2 } },
      base: { repo: { id: 1 } },
    },
    { author_association: "FIRST_TIMER", head: { repo: { id: 2 } }, base: { repo: { id: 1 } } },
  ])("fails closed for untrusted/missing metadata: %j", (pr) => {
    expect(reviewAuthorTrust(pr)).toBe("awaiting_approval");
  });
});

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
