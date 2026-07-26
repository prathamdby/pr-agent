import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE } from "../src/agent/description/descriptionSchema.js";
import {
  buildSubmitDescriptionTool,
  createSubmitDescriptionState,
} from "../src/agent/description/submitDescriptionTool.js";
import { makeTestConfig } from "./helpers/config.js";

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

function buildTool(operationIntent?: { client: Pool; workItemId: string; resourceKey: string }) {
  return buildSubmitDescriptionTool({
    cfg: makeTestConfig(),
    token: "token",
    owner: "o",
    repo: "r",
    prNumber: 1,
    state: createSubmitDescriptionState(),
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
});
