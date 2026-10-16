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
import { buildFindingInventory } from "../src/review/findingIdentity/findingInventory.js";
import {
  OVERLAP_WINDOW_LINES,
  overlaps,
  reconcileObservation,
  type ObservationRelation,
} from "../src/review/findingIdentity/findingReconcile.js";
import type {
  ReviewThreadResolutionStatus,
  ReviewThreadSnapshot,
} from "../src/github/reviewThreadResolution.js";

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

let nextRoot = 100;

function thread(
  overrides: Partial<ReviewThreadSnapshot> & {
    readonly rootBody: string;
    readonly rootAuthor?: string | null;
    readonly replies?: readonly { readonly body: string; readonly authorLogin: string | null }[];
  },
): ReviewThreadSnapshot {
  const rootCommentId = overrides.rootCommentId ?? nextRoot++;
  const { rootBody, rootAuthor, replies, ...rest } = overrides;
  const createdAt =
    rest.comments?.[0]?.createdAt ??
    `2026-01-01T00:00:${String(rootCommentId % 60).padStart(2, "0")}Z`;
  return {
    threadNodeId: `PRRT_${rootCommentId}`,
    isResolved: false,
    rootCommentId,
    path: "src/a.ts",
    line: 10,
    startLine: null,
    originalLine: 10,
    originalStartLine: null,
    isOutdated: false,
    diffSide: "RIGHT",
    commentsComplete: true,
    comments: [
      {
        databaseId: rootCommentId,
        authorLogin: rootAuthor === undefined ? "pr-agent" : rootAuthor,
        body: rootBody,
        createdAt,
        url: `https://github.com/o/r/pull/1#discussion_r${rootCommentId}`,
      },
      ...(replies ?? []).map((reply, index) => ({
        databaseId: rootCommentId * 1000 + index,
        authorLogin: reply.authorLogin,
        body: reply.body,
        createdAt,
        url: `https://github.com/o/r/pull/1#discussion_r${rootCommentId * 1000 + index}`,
      })),
    ],
    ...rest,
  };
}

function markedBody(findingId: FindingId, severity: "P0" | "P1" | "P2" | "P3" = "P1"): string {
  return `**${severity}** · **Title ${findingId}**\n\ndetail\n\n${renderFindingMarker({ id: findingId, lens: "correctness", severity })}`;
}

function inventoryOf(
  threads: readonly ReviewThreadSnapshot[],
  options: {
    readonly status?: ReviewThreadResolutionStatus;
    readonly summary?: {
      readonly body: string;
      readonly authorLogin: string | null;
      readonly url: string;
    } | null;
    readonly summaryComplete?: boolean;
    readonly renames?: ReadonlyMap<string, string>;
    readonly deletedPaths?: ReadonlySet<string>;
  } = {},
) {
  return buildFindingInventory({
    threads: { status: options.status ?? "ok", threads },
    summary: options.summary ?? null,
    summaryComplete: options.summaryComplete ?? true,
    botLogin: BOT,
    renames: options.renames ?? new Map(),
    deletedPaths: options.deletedPaths ?? new Set(),
  });
}

const C = id("f_0000000000000000000000000C");

describe("finding inventory", () => {
  it("rebuilds a marked open finding from its thread", () => {
    const inventory = inventoryOf([thread({ rootBody: markedBody(A, "P0") })]);
    expect(inventory.completeness).toBe("complete");
    expect(inventory.findings.get(A)).toMatchObject({
      id: A,
      source: "thread",
      legacy: false,
      path: "src/a.ts",
      line: 10,
      positionStale: false,
      state: "open",
      lens: "correctness",
      severity: "P0",
      title: `Title ${A}`,
      hasHumanReplies: false,
      commentsComplete: true,
      fileDeleted: false,
    });
  });

  it("ignores a forged marker on a user-authored thread root", () => {
    const inventory = inventoryOf([thread({ rootBody: markedBody(A), rootAuthor: "mallory" })]);
    expect(inventory.findings.size).toBe(0);
  });

  it("assigns a stable legacy id to an unmarked bot finding thread", () => {
    const legacy = thread({ rootBody: "**P2** · **Old finding**\n\ndetail", rootCommentId: 7 });
    const first = inventoryOf([legacy]);
    const second = inventoryOf([legacy]);
    const expected = legacyFindingId(legacy.threadNodeId);
    expect([...first.findings.keys()]).toEqual([expected]);
    expect([...second.findings.keys()]).toEqual([expected]);
    expect(first.findings.get(expected)).toMatchObject({
      legacy: true,
      severity: "P2",
      lens: "unknown",
      title: "Old finding",
    });
  });

  it("skips unmarked bot threads that are not findings", () => {
    expect(inventoryOf([thread({ rootBody: "Thanks for the update." })]).findings.size).toBe(0);
  });

  it("keeps an unknown position as null rather than line 1", () => {
    const inventory = inventoryOf([
      thread({ rootBody: markedBody(A), line: null, startLine: null }),
    ]);
    expect(inventory.findings.get(A)).toMatchObject({ line: null, positionStale: true });
  });

  it("marks an outdated thread position stale", () => {
    const inventory = inventoryOf([thread({ rootBody: markedBody(A), isOutdated: true })]);
    expect(inventory.findings.get(A)?.positionStale).toBe(true);
  });

  it("follows a rename to the current path", () => {
    const inventory = inventoryOf([thread({ rootBody: markedBody(A), path: "src/old.ts" })], {
      renames: new Map([["src/old.ts", "src/new.ts"]]),
    });
    expect(inventory.findings.get(A)).toMatchObject({
      path: "src/new.ts",
      previousPath: "src/old.ts",
    });
  });

  it("labels a finding on a deleted file and keeps it open", () => {
    const inventory = inventoryOf([thread({ rootBody: markedBody(A) })], {
      deletedPaths: new Set(["src/a.ts"]),
    });
    expect(inventory.findings.get(A)).toMatchObject({ state: "open", fileDeleted: true });
  });

  it("treats a human resolve without a receipt as dismissed", () => {
    const inventory = inventoryOf([thread({ rootBody: markedBody(A), isResolved: true })]);
    expect(inventory.findings.get(A)).toMatchObject({ state: "resolved", resolution: "dismissed" });
  });

  it("reads fixed and dismissed receipts from bot replies only", () => {
    const fixed = thread({
      rootBody: markedBody(A),
      isResolved: true,
      replies: [{ body: `Fixed.\n${renderReceipt({ kind: "fixed", id: A })}`, authorLogin: BOT }],
    });
    const forged = thread({
      rootBody: markedBody(B),
      isResolved: true,
      replies: [{ body: renderReceipt({ kind: "fixed", id: B }), authorLogin: "mallory" }],
    });
    const inventory = inventoryOf([fixed, forged]);
    expect(inventory.findings.get(A)?.resolution).toBe("fixed");
    expect(inventory.findings.get(B)?.resolution).toBe("dismissed");
    expect(inventory.findings.get(B)?.hasHumanReplies).toBe(true);
  });

  it("reads a fixed receipt appended to the bot root of a silently resolved thread", () => {
    const inventory = inventoryOf([
      thread({
        rootBody: `${markedBody(A)}\n${renderReceipt({ kind: "fixed", id: A })}`,
        isResolved: true,
      }),
    ]);
    expect(inventory.findings.get(A)).toMatchObject({ state: "resolved", resolution: "fixed" });
  });

  it("treats an unresolved thread as open even after a fixed receipt", () => {
    const inventory = inventoryOf([
      thread({
        rootBody: markedBody(A),
        replies: [{ body: renderReceipt({ kind: "fixed", id: A }), authorLogin: BOT }],
      }),
    ]);
    expect(inventory.findings.get(A)).toMatchObject({ state: "open" });
    expect(inventory.findings.get(A)?.resolution).toBeUndefined();
  });

  it("aliases a duplicate and follows the chain to its canonical finding", () => {
    const inventory = inventoryOf([
      thread({ rootBody: markedBody(A) }),
      thread({
        rootBody: markedBody(B),
        isResolved: true,
        replies: [
          { body: renderReceipt({ kind: "duplicate", id: B, canonical: A }), authorLogin: BOT },
        ],
      }),
      thread({
        rootBody: markedBody(C),
        isResolved: true,
        replies: [
          { body: renderReceipt({ kind: "duplicate", id: C, canonical: B }), authorLogin: BOT },
        ],
      }),
    ]);
    expect(inventory.findings.get(B)).toMatchObject({ resolution: "duplicate", aliasOf: A });
    expect(inventory.canonicalOf(C)).toBe(A);
    expect(inventory.canonicalOf(A)).toBe(A);
  });

  it("returns null for an alias cycle or a missing canonical", () => {
    const cycle = inventoryOf([
      thread({
        rootBody: markedBody(A),
        isResolved: true,
        replies: [
          { body: renderReceipt({ kind: "duplicate", id: A, canonical: B }), authorLogin: BOT },
        ],
      }),
      thread({
        rootBody: markedBody(B),
        isResolved: true,
        replies: [
          { body: renderReceipt({ kind: "duplicate", id: B, canonical: A }), authorLogin: BOT },
        ],
      }),
      thread({
        rootBody: markedBody(C),
        isResolved: true,
        replies: [
          {
            body: renderReceipt({
              kind: "duplicate",
              id: C,
              canonical: id("f_000000000000000000000000ZZ"),
            }),
            authorLogin: BOT,
          },
        ],
      }),
    ]);
    expect(cycle.canonicalOf(A)).toBeNull();
    expect(cycle.canonicalOf(C)).toBeNull();
    expect(cycle.canonicalOf(id("f_000000000000000000000000YY"))).toBeNull();
  });

  it("keeps the oldest thread canonical when one id appears on two threads", () => {
    const older = thread({ rootBody: markedBody(A), rootCommentId: 11 });
    const newer = thread({ rootBody: markedBody(A), rootCommentId: 12 });
    const inventory = inventoryOf([newer, older]);
    expect(inventory.findings.get(A)?.threadId).toBe(older.threadNodeId);
    expect(inventory.sameIdCopies.map((copy) => copy.threadId)).toEqual([newer.threadNodeId]);
  });

  it("reports partial and unavailable thread reads", () => {
    expect(
      inventoryOf([thread({ rootBody: markedBody(A) })], { status: "partial" }).completeness,
    ).toBe("partial");
    expect(inventoryOf([], { status: "unavailable" }).completeness).toBe("unavailable");
    expect(inventoryOf([], { status: "permission_denied" }).completeness).toBe("permission_denied");
    expect(inventoryOf([], { summaryComplete: false }).completeness).toBe("partial");
  });

  it("flags a thread whose comments exceed one page", () => {
    const inventory = inventoryOf([thread({ rootBody: markedBody(A), commentsComplete: false })]);
    expect(inventory.findings.get(A)?.commentsComplete).toBe(false);
  });

  it("rebuilds summary-only rows from the bot summary comment, letting a thread win", () => {
    const rows = [
      renderFindingRowMarker({
        id: A,
        lens: "review",
        severity: "P2",
        path: "src/b.ts",
        line: 4,
        title: "Row A",
      }),
      renderFindingRowMarker({
        id: B,
        lens: "review",
        severity: "P3",
        path: "src/c.ts",
        line: null,
        title: "Row B",
      }),
    ].join("\n");
    const summary = {
      body: rows,
      authorLogin: BOT,
      url: "https://github.com/o/r/pull/1#issuecomment-1",
    };
    const inventory = inventoryOf([thread({ rootBody: markedBody(A) })], { summary });
    expect(inventory.findings.get(A)?.source).toBe("thread");
    expect(inventory.findings.get(B)).toMatchObject({
      source: "summary",
      state: "open",
      path: "src/c.ts",
      line: null,
      positionStale: true,
      severity: "P3",
      title: "Row B",
      url: summary.url,
    });
    expect(inventoryOf([], { summary: { ...summary, authorLogin: "mallory" } }).findings.size).toBe(
      0,
    );
  });
});

const MINTED = id("f_00000000000000000000000MNT");

function observation(overrides: { file?: string; startLine?: number; endLine?: number } = {}) {
  return {
    file: overrides.file ?? "src/a.ts",
    startLine: overrides.startLine ?? 12,
    endLine: overrides.endLine ?? overrides.startLine ?? 12,
    severity: "P1" as const,
    title: "Reworded null dereference",
  };
}

function reconcile(
  relation: ObservationRelation,
  threads: readonly ReviewThreadSnapshot[],
  options: {
    readonly obs?: ReturnType<typeof observation>;
    readonly status?: ReviewThreadResolutionStatus;
    readonly overlapRoundsLeft?: 0 | 1;
    readonly accepted?: Parameters<typeof reconcileObservation>[0]["acceptedThisRun"];
  } = {},
) {
  return reconcileObservation({
    observation: options.obs ?? observation(),
    relation,
    inventory: inventoryOf(threads, { status: options.status }),
    acceptedThisRun: options.accepted ?? [],
    overlapRoundsLeft: options.overlapRoundsLeft ?? 1,
    mint: () => MINTED,
  });
}

describe("observation reconciliation", () => {
  const open = () => thread({ rootBody: markedBody(A), line: 10 });

  it("overlaps within the window on the same path, ignoring lens", () => {
    const finding = inventoryOf([open()]).findings.get(A);
    if (finding == null) throw new Error("missing finding");
    expect(overlaps(observation({ startLine: 10 + OVERLAP_WINDOW_LINES }), finding)).toBe(true);
    expect(overlaps(observation({ startLine: 11 + OVERLAP_WINDOW_LINES }), finding)).toBe(false);
    expect(overlaps(observation({ file: "src/b.ts", startLine: 10 }), finding)).toBe(false);
  });

  it("overlaps anywhere in the file when the finding position is unknown or stale", () => {
    const unknown = inventoryOf([thread({ rootBody: markedBody(A), line: null })]).findings.get(A);
    const stale = inventoryOf([thread({ rootBody: markedBody(A), isOutdated: true })]).findings.get(
      A,
    );
    if (unknown == null || stale == null) throw new Error("missing finding");
    expect(overlaps(observation({ startLine: 900 }), unknown)).toBe(true);
    expect(overlaps(observation({ startLine: 900 }), stale)).toBe(true);
  });

  it("posts a brand-new observation that overlaps nothing with a minted id", () => {
    expect(reconcile({ kind: "new" }, [])).toEqual({
      outcome: { kind: "post_thread", id: MINTED, relatedLinks: [] },
    });
  });

  it("asks instead of matching when a new observation overlaps an open finding", () => {
    const step = reconcile({ kind: "new" }, [open()]);
    expect(step).toMatchObject({ question: { candidates: [{ findingId: A }] } });
  });

  it("keeps an unanswered overlap off the PR as a durable summary row", () => {
    expect(reconcile({ kind: "new" }, [open()], { overlapRoundsLeft: 0 })).toEqual({
      outcome: { kind: "summary_only", id: MINTED, reason: "unanswered_overlap" },
    });
  });

  it("reaffirms a reworded or moved observation that continues an open finding", () => {
    expect(reconcile({ kind: "continues", findingId: A }, [open()])).toEqual({
      outcome: { kind: "reaffirm", id: A, severity: "P1" },
    });
  });

  it("follows a rename when the observation continues a finding on the old path", () => {
    const renamed = thread({ rootBody: markedBody(A), path: "src/old.ts" });
    const step = reconcileObservation({
      observation: observation({ file: "src/new.ts" }),
      relation: { kind: "continues", findingId: A },
      inventory: inventoryOf([renamed], { renames: new Map([["src/old.ts", "src/new.ts"]]) }),
      acceptedThisRun: [],
      overlapRoundsLeft: 1,
      mint: () => MINTED,
    });
    expect(step).toEqual({ outcome: { kind: "reaffirm", id: A, severity: "P1" } });
  });

  it("rejects continues on an unknown, distant, or other-file finding", () => {
    expect(reconcile({ kind: "continues", findingId: B }, [open()])).toHaveProperty("rejected");
    expect(
      reconcile({ kind: "continues", findingId: A }, [open()], {
        obs: observation({ startLine: 400 }),
      }),
    ).toHaveProperty("rejected");
    expect(
      reconcile({ kind: "continues", findingId: A }, [open()], {
        obs: observation({ file: "src/z.ts" }),
      }),
    ).toHaveProperty("rejected");
  });

  it("posts two defects on one line when the model answers distinct_from", () => {
    expect(
      reconcile({ kind: "distinct_from", findingIds: [A], reason: "different variable" }, [open()]),
    ).toEqual({ outcome: { kind: "post_thread", id: MINTED, relatedLinks: [] } });
  });

  it("still asks when distinct_from leaves an overlapping candidate unanswered", () => {
    const other = thread({ rootBody: markedBody(B), line: 14 });
    expect(
      reconcile({ kind: "distinct_from", findingIds: [A], reason: "x" }, [open(), other]),
    ).toMatchObject({ question: { candidates: [{ findingId: B }] } });
  });

  it("keeps both on uncertain, linking the possibly related thread", () => {
    const step = reconcile({ kind: "uncertain", findingIds: [A] }, [open()]);
    expect(step).toMatchObject({ outcome: { kind: "post_thread", id: MINTED } });
    if (!("outcome" in step) || step.outcome.kind !== "post_thread")
      throw new Error("expected post");
    expect(step.outcome.relatedLinks).toHaveLength(1);
  });

  it("suppresses recurrence of a dismissed finding and reopens a fixed one", () => {
    const dismissed = thread({ rootBody: markedBody(A), isResolved: true });
    expect(reconcile({ kind: "continues", findingId: A }, [dismissed])).toEqual({
      outcome: { kind: "suppressed_dismissed", id: A },
    });
    const fixed = thread({
      rootBody: `${markedBody(A)}\n${renderReceipt({ kind: "fixed", id: A })}`,
      isResolved: true,
    });
    expect(reconcile({ kind: "continues", findingId: A }, [fixed])).toEqual({
      outcome: { kind: "post_thread", id: MINTED, reopens: A, relatedLinks: [] },
    });
  });

  it("resolves continues on a duplicate to its canonical finding", () => {
    const duplicate = thread({
      rootBody: markedBody(B),
      isResolved: true,
      replies: [
        { body: renderReceipt({ kind: "duplicate", id: B, canonical: A }), authorLogin: BOT },
      ],
    });
    expect(reconcile({ kind: "continues", findingId: B }, [open(), duplicate])).toEqual({
      outcome: { kind: "reaffirm", id: A, severity: "P1" },
    });
  });

  it("promotes a summary-only finding with the same id when it is re-observed", () => {
    const summary = {
      body: renderFindingRowMarker({
        id: A,
        lens: "review",
        severity: "P2",
        path: "src/a.ts",
        line: 12,
        title: "Row",
      }),
      authorLogin: BOT,
      url: "https://github.com/o/r/pull/1#issuecomment-1",
    };
    const step = reconcileObservation({
      observation: observation(),
      relation: { kind: "continues", findingId: A },
      inventory: inventoryOf([], { summary }),
      acceptedThisRun: [],
      overlapRoundsLeft: 1,
      mint: () => MINTED,
    });
    expect(step).toEqual({ outcome: { kind: "promote", id: A } });
  });

  it("treats same-run accepted findings as overlap candidates", () => {
    const accepted = [
      { id: B, path: "src/a.ts", startLine: 12, endLine: 12, title: "Earlier", url: "" },
    ];
    expect(reconcile({ kind: "new" }, [], { accepted })).toMatchObject({
      question: { candidates: [{ findingId: B }] },
    });
    expect(reconcile({ kind: "continues", findingId: B }, [], { accepted })).toEqual({
      outcome: { kind: "reaffirm", id: B, severity: "P1" },
    });
  });

  it("never posts a thread from an incomplete inventory", () => {
    for (const status of ["partial", "unavailable", "permission_denied"] as const) {
      expect(reconcile({ kind: "new" }, [], { status })).toEqual({
        outcome: { kind: "summary_only", id: MINTED, reason: "inventory_incomplete" },
      });
      expect(reconcile({ kind: "uncertain", findingIds: [A] }, [open()], { status })).toEqual({
        outcome: { kind: "summary_only", id: MINTED, reason: "inventory_incomplete" },
      });
    }
  });
});
