import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logDebug, logWarn } from "../../evlog.js";
import { resolveAgentRunnerProvider } from "../../agent/providers/index.js";
import { redactReviewText } from "../findings/reviewPublicOutput.js";
import { buildCiContextUserMessage, CI_SUMMARY_SYSTEM_PROMPT } from "./ciGatePrompt.js";
import { ciSummaryLlmSchema, type CiSummaryLlmFields } from "./ciSummarySchema.js";
import type { CiFailureDetail, CiSummary, CiSummaryStatus } from "./ciSummaryTypes.js";

export type CiAuthorInput = {
  readonly status: Extract<CiSummaryStatus, "passing" | "failing" | "pending" | "none">;
  readonly checkNames: readonly string[];
  readonly failingNames: readonly string[];
  readonly failingUrls: ReadonlyMap<string, string | undefined>;
  readonly condensedLogs: string;
  readonly checkOutputFallback: string;
};

export type CiSummaryAuthor = (input: CiAuthorInput) => Promise<CiSummaryLlmFields | null>;

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new AppError({
      code: "ci.summary_no_json",
      message: "CI summary LLM response contained no JSON object",
    });
  }
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

export function parseCiSummaryLlmText(text: string): CiSummaryLlmFields {
  const parsed = extractJsonObject(text);
  return ciSummaryLlmSchema.parse(parsed);
}

/**
 * Merges model-authored fields with server facts. Status and failure names are owned by
 * the server; the model supplies headline/reason/fixHint prose.
 */
export function mergeCiSummaryWithFacts(input: CiAuthorInput, llm: CiSummaryLlmFields): CiSummary {
  const byName = new Map(llm.failures.map((f) => [f.name.toLowerCase(), f]));
  const failures: CiFailureDetail[] = [];

  if (input.status === "failing") {
    for (const name of input.failingNames) {
      const match = byName.get(name.toLowerCase());
      const reason = redactReviewText(
        match?.reason ?? "Check failed; see the linked job logs for details.",
      );
      const fixHint = redactReviewText(
        match?.fixHint ?? `Inspect the failing “${name}” check, fix the error, and re-push.`,
      );
      failures.push({
        name,
        reason,
        fixHint,
        url: input.failingUrls.get(name),
      });
    }
  }

  const headline =
    input.status === "passing"
      ? "✅ All CI is passing"
      : input.status === "pending"
        ? "⏳ CI still running"
        : input.status === "none"
          ? "No CI checks on this head"
          : redactReviewText(llm.headline);

  return {
    status: input.status,
    headline,
    failures,
  };
}

/** Production author: one tool-free agent turn, JSON out. Soft-fails to null. */
export function createAgentCiSummaryAuthor(cfg: Config): CiSummaryAuthor {
  return async (input) => {
    if (input.status !== "failing") {
      return {
        headline:
          input.status === "passing"
            ? "✅ All CI is passing"
            : input.status === "pending"
              ? "⏳ CI still running"
              : "No CI checks on this head",
        failures: [],
      };
    }

    const runner = resolveAgentRunnerProvider(cfg);
    const session = await runner.createSession({
      cfg,
      systemPrompt: CI_SUMMARY_SYSTEM_PROMPT,
      tools: [],
      executors: {},
    });
    try {
      const prompt = buildCiContextUserMessage(input);
      const turn = await session.send(prompt, { maxToolRounds: 0 });
      const fields = parseCiSummaryLlmText(turn.text);
      logDebug("review_ci_summary_authored", {
        failureCount: fields.failures.length,
        headlineChars: fields.headline.length,
      });
      return fields;
    } catch (error) {
      logWarn("review_ci_summary_author_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      await session.dispose();
    }
  };
}

/** Facts-only failing summary when the LLM call is skipped or fails. */
export function factsOnlyFailingSummary(input: CiAuthorInput): CiSummary {
  const nameList = input.failingNames.slice(0, 3).join(", ");
  const more = input.failingNames.length > 3 ? ` (+${input.failingNames.length - 3} more)` : "";
  return {
    status: "failing",
    headline: `❌ CI failing — ${nameList}${more}`,
    failures: input.failingNames.map((name) => ({
      name,
      reason: "Check failed; CI log summary was unavailable.",
      fixHint: `Inspect the failing “${name}” check, fix the error, and re-push.`,
      url: input.failingUrls.get(name),
    })),
  };
}
