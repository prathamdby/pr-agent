import { describe, expect, it } from "vitest";
import {
  isFindingId,
  legacyFindingId,
  mintFindingId,
  parseOwnedFindingMarker,
  parseOwnedFindingRows,
  parseOwnedReceipts,
  renderFindingMarker,
  renderFindingRowMarker,
  renderReceipt,
  type FindingId,
} from "../src/review/findingIdentity/findingMarker.js";

const BOT = "pr-agent[bot]";

function id(value: string): FindingId {
  if (!isFindingId(value)) throw new Error(`not a finding id: ${value}`);
  return value;
}

const A = id("f_0000000000000000000000000A");
const B = id("f_0000000000000000000000000B");

describe("finding markers", () => {
  it("mints unique well-formed ids", () => {
    const minted = new Set(Array.from({ length: 200 }, () => mintFindingId()));
    expect(minted.size).toBe(200);
    for (const value of minted) expect(value).toMatch(/^f_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("derives a stable legacy id from the thread node id", () => {
    expect(legacyFindingId("PRRT_abc")).toBe(legacyFindingId("PRRT_abc"));
    expect(legacyFindingId("PRRT_abc")).not.toBe(legacyFindingId("PRRT_abd"));
    expect(legacyFindingId("PRRT_abc")).toMatch(/^l_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("round-trips a root marker written by the bot", () => {
    const body = `**P1** · **Null deref**\n\ndetail\n${renderFindingMarker({
      id: A,
      lens: "correctness",
      severity: "P1",
      reopens: B,
    })}`;
    expect(parseOwnedFindingMarker({ body, authorLogin: BOT, isRoot: true }, BOT)).toEqual({
      id: A,
      lens: "correctness",
      severity: "P1",
      reopens: B,
    });
  });

  it("matches the bot login with or without the GraphQL-dropped [bot] suffix", () => {
    const body = renderFindingMarker({ id: A, lens: "review", severity: "P2" });
    expect(parseOwnedFindingMarker({ body, authorLogin: "pr-agent", isRoot: true }, BOT)?.id).toBe(
      A,
    );
    expect(parseOwnedFindingMarker({ body, authorLogin: BOT, isRoot: true }, "pr-agent")?.id).toBe(
      A,
    );
  });

  it("ignores a forged marker in a user comment", () => {
    const body = renderFindingMarker({ id: A, lens: "review", severity: "P0" });
    expect(parseOwnedFindingMarker({ body, authorLogin: "mallory", isRoot: true }, BOT)).toBeNull();
    expect(parseOwnedFindingMarker({ body, authorLogin: null, isRoot: true }, BOT)).toBeNull();
  });

  it("ignores a marker in a reply instead of the thread root", () => {
    const body = renderFindingMarker({ id: A, lens: "review", severity: "P1" });
    expect(parseOwnedFindingMarker({ body, authorLogin: BOT, isRoot: false }, BOT)).toBeNull();
  });

  it("ignores an unknown marker version or malformed fields", () => {
    const forms = [
      `<!-- pr-agent:finding v=2 id=${A} lens=review sev=P1 -->`,
      `<!-- pr-agent:finding v=1 id=f_short lens=review sev=P1 -->`,
      `<!-- pr-agent:finding v=1 id=${A} lens=style sev=P1 -->`,
      `<!-- pr-agent:finding v=1 id=${A} lens=review sev=P9 -->`,
      `text <!-- pr-agent:finding v=1 id=${A} lens=review sev=P1 --> trailing`,
    ];
    for (const body of forms) {
      expect(parseOwnedFindingMarker({ body, authorLogin: BOT, isRoot: true }, BOT)).toBeNull();
    }
  });

  it("refuses a root that carries two finding markers", () => {
    const body = [
      renderFindingMarker({ id: A, lens: "review", severity: "P1" }),
      renderFindingMarker({ id: B, lens: "review", severity: "P1" }),
    ].join("\n");
    expect(parseOwnedFindingMarker({ body, authorLogin: BOT, isRoot: true }, BOT)).toBeNull();
  });

  it("round-trips summary rows whose path and title hold marker-breaking text", () => {
    const row = {
      id: A,
      lens: "security" as const,
      severity: "P2" as const,
      path: "src/a b/-->x.ts",
      line: null,
      title: "Title with --> and | pipes",
    };
    const body = `| New | P2 | t | x | ${renderFindingRowMarker(row)}\n| x | ${renderFindingRowMarker(
      {
        ...row,
        id: B,
        line: 7,
      },
    )}`;
    expect(parseOwnedFindingRows({ body, authorLogin: BOT }, BOT)).toEqual([
      row,
      { ...row, id: B, line: 7 },
    ]);
    expect(parseOwnedFindingRows({ body, authorLogin: "mallory" }, BOT)).toEqual([]);
  });

  it("parses receipts only from bot-authored comments", () => {
    const duplicate = renderReceipt({ kind: "duplicate", id: B, canonical: A });
    const fixed = renderReceipt({ kind: "fixed", id: A });
    expect(
      parseOwnedReceipts(
        [
          { body: `Tracked elsewhere.\n${duplicate}`, authorLogin: BOT },
          { body: fixed, authorLogin: "mallory" },
          { body: renderReceipt({ kind: "dismissed", id: A }), authorLogin: "pr-agent" },
        ],
        BOT,
      ),
    ).toEqual([
      { kind: "duplicate", id: B, canonical: A },
      { kind: "dismissed", id: A },
    ]);
  });
});
