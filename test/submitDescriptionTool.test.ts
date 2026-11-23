import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESCRIPTION_PAYLOAD_BASE_EXAMPLE } from "../src/prompts/description/prompt.ts";
import {
  buildSubmitDescriptionTool,
  createSubmitDescriptionState,
} from "../src/agent/description/submitDescriptionTool.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";

import {
  legacyIntentStore,
  openExecutorDurableHarness,
  testPublication,
  type ExecutorDurableHarness,
} from "./helpers/executorDurableHarness.ts";
import type { FeaturePublication } from "../src/state/featurePublication.ts";
const updatePullRequest = vi.fn();

let harness: ExecutorDurableHarness;

function buildTool(
  publication?: FeaturePublication,
  extras?: { mapMode?: "omit" | "read_first"; knownPaths?: ReadonlySet<string> },
) {
  const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  return buildSubmitDescriptionTool({
    cfg: makeTestConfig(),
    prSurface: { ...surface, updatePullRequest },
    owner: "o",
    repo: "r",
    prNumber: 1,
    state: createSubmitDescriptionState(),
    mapMode: extras?.mapMode ?? "read_first",
    knownPaths: extras?.knownPaths,
    publication,
  });
}

describe("submitDescription tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness = openExecutorDurableHarness();
    updatePullRequest.mockResolvedValue({ prNumber: 1 });
  });
  afterEach(() => {
    harness.close();
  });

  it("keeps its parameter schema identical across builds", () => {
    const first = buildTool().piTool;
    const second = buildTool().piTool;
    expect(second.parameters).toBe(first.parameters);
  });

  it("wraps publish in operation-intent persistence when context is provided", async () => {
    const { executor } = buildTool(
      testPublication(harness.db, { workId: "wi-1", kind: "description" }),
    );
    const result = await executor({ ...DESCRIPTION_PAYLOAD_BASE_EXAMPLE });

    expect(result).toEqual({
      ok: true,
      prNumber: 1,
      titleUpdated: true,
      bodyUpdated: true,
    });
    expect(updatePullRequest).toHaveBeenCalledTimes(1);
    expect(
      await legacyIntentStore(harness.db).getOperationIntent(
        undefined,
        "wi-1",
        "description:pr_body:o/r#1",
      ),
    ).toMatchObject({ status: "reconciled", mutationKind: "github.pr_body" });
  });

  it("publishes without operation-intent persistence when context is omitted", async () => {
    const { executor } = buildTool();
    await executor({ ...DESCRIPTION_PAYLOAD_BASE_EXAMPLE });

    expect(updatePullRequest).toHaveBeenCalledTimes(1);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM publish_intents").get()).toEqual({
      n: 0,
    });
  });

  it("publishes the shared base example and keeps its legal visual", async () => {
    const { executor } = buildTool(undefined, { mapMode: "omit" });
    await executor({ ...DESCRIPTION_PAYLOAD_BASE_EXAMPLE });

    const published = updatePullRequest.mock.calls[0][0];
    expect(published.body).toContain("handleRequest\n  validateSession\n  next");
  });

  it("strips prFiles on omit mode before publish", async () => {
    const { executor } = buildTool(undefined, { mapMode: "omit" });
    await executor({
      ...DESCRIPTION_PAYLOAD_BASE_EXAMPLE,
      prFiles: [
        {
          filename: "src/auth/session.ts",
          changesTitle: "Auth boundary is the highest-risk surface in this PR",
        },
      ],
    });

    const published = updatePullRequest.mock.calls[0][0];
    expect(published.body).not.toContain("src/auth/session.ts");
    expect(published.body).toContain("handleRequest\n  validateSession\n  next");
  });

  it("repairs a single-object prFiles payload at the parse seam", async () => {
    const { executor } = buildTool();

    await executor({
      ...DESCRIPTION_PAYLOAD_BASE_EXAMPLE,
      prFiles: { filename: "src/auth/session.ts", changesTitle: "Auth boundary" },
    });

    const published = updatePullRequest.mock.calls[0][0];
    expect(published.body).toContain("src/auth/session.ts");
    expect(published.body).toContain("Auth boundary");
  });

  it("enforces title rules before publish", async () => {
    const { executor } = buildTool();
    await executor({
      ...DESCRIPTION_PAYLOAD_BASE_EXAMPLE,
      title: "feat: add user session validation.",
    });

    const published = updatePullRequest.mock.calls[0][0];
    expect(published.title).toBe("Add user session validation");
  });

  it("sanitizes mermaid visuals before publish", async () => {
    const raw = [
      "```mermaid",
      "flowchart LR",
      "  J[Admin Users List] --> K[/api/admin-users/list proxy]",
      "```",
    ].join("\n");
    const { executor } = buildTool();
    await executor({
      title: "Update admin flow",
      type: ["Enhancement"],
      description: "- Route admin list through proxy",
      visuals: [{ kind: "mermaid", content: raw }],
    });

    const published = updatePullRequest.mock.calls[0][0];
    expect(published.body).toContain('K["api/admin-users/list proxy"]');
  });

  it("publishes quoted mermaid labels with real newlines", async () => {
    const content = String.raw`flowchart LR\n  A["copy click in preview hook"] --> B["copyTicketAttachment"]\n  B --> C["loadTicketAttachmentBlob -> POST /api/ticket-attachment-bytes"]`;
    const { executor } = buildTool();
    await executor({
      title: "Copy ticket attachment bytes",
      type: ["Enhancement"],
      description: "- The preview copy control writes image bytes.",
      visuals: [{ kind: "mermaid", content }],
    });

    const published = updatePullRequest.mock.calls[0][0];
    const diagram = [
      "```mermaid",
      "flowchart LR",
      '  A["copy click in preview hook"] --> B["copyTicketAttachment"]',
      '  B --> C["loadTicketAttachmentBlob -> POST /api/ticket-attachment-bytes"]',
      "```",
    ].join("\n");
    expect(published.body).toContain(diagram);
    expect(published.body).not.toContain("hookn");
    expect(published.body).not.toContain(String.raw`\n`);
  });

  it("rejects invalid mermaid on full_block language mermaid", async () => {
    const { executor } = buildTool();
    await expect(
      executor({
        title: "Update admin flow",
        type: ["Enhancement"],
        description: "- Route admin list through proxy",
        visuals: [
          {
            kind: "full_block",
            language: "mermaid",
            content: ["flowchart BAD", '  A["Start"] --> B["End"]'].join("\n"),
          },
        ],
      }),
    ).rejects.toThrow(/mermaid/i);
    expect(updatePullRequest).not.toHaveBeenCalled();
  });

  it("caps read_first prFiles at five before publish", async () => {
    const prFiles = Array.from({ length: 8 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      changesTitle: `Reason ${i}`,
    }));
    const { executor } = buildTool(undefined, { mapMode: "read_first" });
    await executor({
      title: "Large map",
      type: ["Enhancement"],
      description: "- Main",
      prFiles,
    });

    const published = updatePullRequest.mock.calls[0][0];
    expect(published.body).toContain("src/f4.ts");
    expect(published.body).not.toContain("src/f5.ts");
  });
});
