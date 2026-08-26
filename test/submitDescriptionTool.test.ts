import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE } from "../src/agent/description/descriptionSchema.js";
import {
  buildSubmitDescriptionTool,
  createSubmitDescriptionState,
} from "../src/agent/description/submitDescriptionTool.js";
import { makeTestConfig } from "./helpers/config.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

vi.mock("../src/agentWork/operationIntentRepository.js", () => ({
  persistOperationIntent: vi.fn(),
  mergeOperationIntentDetail: vi.fn(),
  reconcileOperationIntent: vi.fn(),
}));

vi.mock("../src/agent/description/publishDescription.js", () => ({
  publishDescriptionToPullRequest: vi.fn(),
}));

import {
  mergeOperationIntentDetail,
  persistOperationIntent,
  reconcileOperationIntent,
} from "../src/agentWork/operationIntentRepository.js";
import { publishDescriptionToPullRequest } from "../src/agent/description/publishDescription.js";

const pool = {} as Pool;

function buildTool(
  operationIntent?: { client: Pool; workItemId: string; resourceKey: string },
  extras?: { mapMode?: "omit" | "read_first"; knownPaths?: ReadonlySet<string> },
) {
  const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  return buildSubmitDescriptionTool({
    cfg: makeTestConfig(),
    prSurface: surface,
    owner: "o",
    repo: "r",
    prNumber: 1,
    state: createSubmitDescriptionState(),
    mapMode: extras?.mapMode ?? "read_first",
    knownPaths: extras?.knownPaths,
    operationIntent,
  });
}

describe("submitDescription tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(persistOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "description:pr_body:o/r#1",
      mutationKind: "github.pr_body",
      status: "pending",
      publishRecordId: null,
      detail: {},
    });
    vi.mocked(mergeOperationIntentDetail).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "description:pr_body:o/r#1",
      mutationKind: "github.pr_body",
      status: "pending",
      publishRecordId: null,
      detail: {},
    });
    vi.mocked(reconcileOperationIntent).mockResolvedValue({
      id: "intent-1",
      workItemId: "wi-1",
      operationKey: "description:pr_body:o/r#1",
      mutationKind: "github.pr_body",
      status: "reconciled",
      publishRecordId: null,
      detail: {},
    });
    vi.mocked(publishDescriptionToPullRequest).mockResolvedValue({
      prNumber: 1,
      titleUpdated: true,
      bodyUpdated: true,
    });
  });

  it("keeps its parameter schema identical across builds", () => {
    const first = buildTool().piTool;
    const second = buildTool().piTool;
    expect(second.parameters).toBe(first.parameters);
  });

  it("wraps publish in operation-intent persistence when context is provided", async () => {
    const calls: string[] = [];
    vi.mocked(persistOperationIntent).mockImplementation(async () => {
      calls.push("persist");
      return {
        id: "intent-1",
        workItemId: "wi-1",
        operationKey: "description:pr_body:o/r#1",
        mutationKind: "github.pr_body",
        status: "pending",
        publishRecordId: null,
        detail: {},
      };
    });
    vi.mocked(publishDescriptionToPullRequest).mockImplementation(async () => {
      calls.push("publish");
      return { prNumber: 1, titleUpdated: true, bodyUpdated: true };
    });
    vi.mocked(reconcileOperationIntent).mockImplementation(async () => {
      calls.push("reconcile");
      return {
        id: "intent-1",
        workItemId: "wi-1",
        operationKey: "description:pr_body:o/r#1",
        mutationKind: "github.pr_body",
        status: "reconciled",
        publishRecordId: null,
        detail: {},
      };
    });

    const { executor } = buildTool({
      client: pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
    const result = await executor({ ...DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE });

    expect(result).toEqual({
      ok: true,
      prNumber: 1,
      titleUpdated: true,
      bodyUpdated: true,
    });
    expect(calls).toEqual(["persist", "publish", "reconcile"]);
    expect(persistOperationIntent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemId: "wi-1",
        operationKey: "description:pr_body:o/r#1",
        mutationKind: "github.pr_body",
      }),
    );
  });

  it("publishes without operation-intent persistence when context is omitted", async () => {
    const { executor } = buildTool();
    await executor({ ...DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE });

    expect(publishDescriptionToPullRequest).toHaveBeenCalledTimes(1);
    expect(persistOperationIntent).not.toHaveBeenCalled();
    expect(reconcileOperationIntent).not.toHaveBeenCalled();
  });

  it("strips prFiles on omit mode before publish", async () => {
    const { executor } = buildTool(undefined, { mapMode: "omit" });
    await executor({ ...DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE });

    expect(publishDescriptionToPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.not.objectContaining({
          prFiles: expect.anything(),
        }),
      }),
    );
    const published = vi.mocked(publishDescriptionToPullRequest).mock.calls[0][0];
    expect(published.payload.prFiles).toBeUndefined();
  });

  it("repairs a single-object prFiles payload at the parse seam", async () => {
    const { executor } = buildTool();

    await executor({
      ...DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE,
      prFiles: { filename: "src/auth/session.ts", changesTitle: "Auth boundary" },
    });

    const published = vi.mocked(publishDescriptionToPullRequest).mock.calls[0][0];
    expect(published.payload.prFiles).toEqual([
      { filename: "src/auth/session.ts", changesTitle: "Auth boundary" },
    ]);
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

    const published = vi.mocked(publishDescriptionToPullRequest).mock.calls[0][0];
    expect(published.payload.prFiles).toHaveLength(5);
  });
});
