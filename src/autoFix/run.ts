import type { Config } from "../config.js";
import { resolveAgentRunnerProvider } from "../agent/providers/index.js";
import type { AutoFixTargetGroup } from "./types.js";
import type { AutoFixWorkspace } from "./workspace.js";
import { buildAutoFixSystemPrompt, buildAutoFixUserPrompt } from "./prompt.js";
import { buildAutoFixTools, type MutableAutoFixSubmitState } from "./tools.js";

export type AutoFixRunResult = {
  readonly outcome: "fixed" | "skipped" | "failed";
  readonly summary: string;
};

export async function runAutoFixTargetGroup(params: {
  cfg: Config;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  workspace: AutoFixWorkspace;
  group: AutoFixTargetGroup;
}): Promise<AutoFixRunResult> {
  const submitState: MutableAutoFixSubmitState = { value: { submitted: false } };
  const tools = buildAutoFixTools(params.workspace, submitState);
  const runner = resolveAgentRunnerProvider(params.cfg);
  const session = await runner.createSession({
    cfg: params.cfg,
    cwd: params.workspace.scratchCwd,
    systemPrompt: buildAutoFixSystemPrompt(),
    tools: tools.piTools,
    executors: tools.executors,
    cursorSandbox: true,
  });

  try {
    const result = await session.send(
      buildAutoFixUserPrompt({
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        headSha: params.headSha,
        group: params.group,
      }),
      { maxToolRounds: params.cfg.maxFixToolRounds },
    );

    if (submitState.value.submitted) {
      return {
        outcome: submitState.value.outcome,
        summary: submitState.value.summary,
      };
    }

    const summary = result.text.trim();
    return {
      outcome: "failed",
      summary: summary || "The agent did not submit an auto-fix result.",
    };
  } finally {
    await session.dispose();
  }
}
