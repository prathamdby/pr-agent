import { describe, expect, it } from "vitest";
import { createFakePrSurface } from "../src/github/prSurface.js";
import { GITHUB_REACTION_EYES } from "../src/settings/index.js";

describe("createFakePrSurface", () => {
  it("tracks progress comment upsert by sentinel", async () => {
    const { surface, controls } = createFakePrSurface({
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    const sentinel = "<!-- pr-agent-review -->";
    const first = await surface.upsertProgressComment("Review in progress", sentinel);
    expect(first.updated).toBe(false);
    expect(first.id).toBeGreaterThan(0);

    const second = await surface.upsertProgressComment("Review complete", sentinel);
    expect(second.updated).toBe(true);
    expect(second.id).toBe(first.id);

    const stored = controls.getProgressComment(sentinel);
    expect(stored?.body).toBe("Review complete");
    expect(controls.events.filter((e) => e.kind === "upsertProgressComment")).toHaveLength(2);
  });

  it("records replyAt and returns comment id", async () => {
    const { surface, controls } = createFakePrSurface({
      owner: "o",
      repo: "r",
      prNumber: 7,
    });

    const reply = await surface.replyAt({ kind: "prConversation", prNumber: 7 }, "acknowledged");
    expect(reply.commentId).toBeGreaterThan(0);
    expect(controls.replies).toEqual([
      { target: { kind: "prConversation", prNumber: 7 }, body: "acknowledged" },
    ]);
  });

  it("manages labels and git credential token", async () => {
    const { surface, controls } = createFakePrSurface(
      { owner: "o", repo: "r", prNumber: 3 },
      { labels: ["bug"], credentialToken: "seed-token" },
    );

    expect(await surface.getLabels()).toEqual(["bug"]);
    await surface.setLabels(["bug", "review"]);
    expect(await surface.getLabels()).toEqual(["bug", "review"]);
    expect(controls.setLabels).toBeDefined();
    expect((await surface.gitCredentialAuth()).token).toBe("seed-token");
  });

  it("reflects rate limit circuit state", async () => {
    const { surface, controls } = createFakePrSurface({
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(surface.isRateLimitCircuitOpen()).toBe(false);
    controls.setRateLimitOpen(true);
    expect(surface.isRateLimitCircuitOpen()).toBe(true);
  });

  it("records acknowledgement reactions", async () => {
    const { surface, controls } = createFakePrSurface({
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    await surface.setAcknowledgementReaction([{ kind: "pr", prNumber: 1 }], GITHUB_REACTION_EYES);
    expect(controls.reactions).toEqual([
      { targets: [{ kind: "pr", prNumber: 1 }], kind: GITHUB_REACTION_EYES },
    ]);
  });
});
