import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Config } from "../config.js";
import { logDebug, logInfo } from "../evlog.js";
import { publishDescriptionToPullRequest } from "./publishDescription.js";
import {
  coerceDescriptionPayloadInput,
  descriptionPayloadSchema,
  DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE,
  formatDescriptionValidationError,
} from "./descriptionSchema.js";
import {
  formatMermaidValidationError,
  sanitizeMermaidDiagram,
  validateSanitizedMermaidFence,
} from "./mermaidDiagram.js";

export type SubmitDescriptionState = {
  published: boolean;
  lastValidationError: string | null;
  publishSuperseded: boolean;
};

export function createSubmitDescriptionState(): SubmitDescriptionState {
  return {
    published: false,
    lastValidationError: null,
    publishSuperseded: false,
  };
}

const SUBMIT_DESCRIPTION_DESCRIPTION = [
  "Submit the completed PR description exactly once.",
  "Pass a DescriptionPayload object matching the schema.",
  "This merges generated content into the pull request body under the PR Agent description header.",
  `Minimal valid example: ${JSON.stringify(DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE)}`,
].join(" ");

const SUBMIT_DESCRIPTION_PARAMETERS = z.toJSONSchema(descriptionPayloadSchema, {
  unrepresentable: "any",
}) as PiTool["parameters"];

export function buildSubmitDescriptionTool(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs?: number;
  getTokenExpiresAtTs?: () => number;
  owner: string;
  repo: string;
  prNumber: number;
  state: SubmitDescriptionState;
  shouldAbortPublish?: () => Promise<boolean>;
  recordPublishStep?: (detail?: Record<string, unknown>) => Promise<void>;
}): {
  piTool: PiTool;
  executor: (args: Record<string, unknown>) => Promise<unknown>;
} {
  const piTool: PiTool = {
    name: "submitDescription",
    description: SUBMIT_DESCRIPTION_DESCRIPTION,
    parameters: SUBMIT_DESCRIPTION_PARAMETERS,
  };

  const executor = async (args: Record<string, unknown>) => {
    if (params.state.published) {
      logDebug("description_submit_duplicate_ignored", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
      });
      return { ok: true, duplicate: true };
    }

    if (params.shouldAbortPublish && (await params.shouldAbortPublish())) {
      params.state.publishSuperseded = true;
      throw new Error(
        "Description publish aborted because this work item was superseded or cancelled.",
      );
    }

    const coerced = coerceDescriptionPayloadInput(args);
    const parsed = descriptionPayloadSchema.safeParse(coerced);
    if (!parsed.success) {
      params.state.lastValidationError = formatDescriptionValidationError(parsed.error);
      throw new Error(params.state.lastValidationError);
    }

    let payload = parsed.data;
    if (payload.changesDiagram?.trim()) {
      const sanitizedDiagram = sanitizeMermaidDiagram(payload.changesDiagram);
      const mermaidIssues = validateSanitizedMermaidFence(sanitizedDiagram);
      if (mermaidIssues.length > 0) {
        params.state.lastValidationError = formatMermaidValidationError(mermaidIssues);
        throw new Error(params.state.lastValidationError);
      }
      payload = { ...payload, changesDiagram: sanitizedDiagram };
    }

    params.state.lastValidationError = null;

    const result = await publishDescriptionToPullRequest({
      cfg: params.cfg,
      token: params.token,
      tokenExpiresAtTs: params.getTokenExpiresAtTs?.() ?? params.tokenExpiresAtTs,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      payload,
    });

    params.state.published = true;
    logInfo("description_published", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      titleUpdated: result.titleUpdated,
      bodyUpdated: result.bodyUpdated,
    });

    if (params.recordPublishStep) {
      await params.recordPublishStep({
        titleUpdated: result.titleUpdated,
        bodyUpdated: result.bodyUpdated,
      });
    }

    return { ok: true, ...result };
  };

  return { piTool, executor };
}
