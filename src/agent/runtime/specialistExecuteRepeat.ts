import { SPECIALIST_REPEATED_EXECUTE_NUDGE } from "../../prompts/shared/repair.ts";
import { SPECIALIST_EXECUTE_NUDGE_AT, SPECIALIST_EXECUTE_STOP_AT } from "../../settings/index.ts";
import { isRecord } from "../../util/typeGuards.ts";
import { CODE_MODE_EXECUTE_NAME } from "../codemode/types.ts";

export { SPECIALIST_REPEATED_EXECUTE_NUDGE };

export type RepeatedExecuteCall = {
  readonly toolName: string;
  readonly code: string;
  readonly result: string;
};

export type SpecialistExecuteObservation = {
  readonly refused: boolean;
  readonly calls: readonly RepeatedExecuteCall[];
};

type ExecuteStreak = {
  result: string;
  count: number;
  nudged: boolean;
};

export function specialistExecuteCalls(input: {
  readonly calls: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: unknown;
  }[];
  readonly results: readonly {
    readonly toolCallId: string;
    readonly text: string;
  }[];
}) {
  const textById = new Map(input.results.map((result) => [result.toolCallId, result.text]));
  const calls: RepeatedExecuteCall[] = [];
  for (const call of input.calls) {
    if (call.name !== CODE_MODE_EXECUTE_NAME) continue;
    const args = call.arguments;
    if (!isRecord(args) || typeof args.code !== "string") continue;

    const result = textById.get(call.id);
    if (result !== undefined) calls.push({ toolName: call.name, code: args.code, result });
  }
  return ((pinnedReturn: RepeatedExecuteCall[]) => pinnedReturn)(calls);
}

export function createSpecialistExecuteRepeat() {
  const streaks = new Map<string, ExecuteStreak>();
  let pendingCodes: string[] = [];

  return {
    observe(observation: SpecialistExecuteObservation) {
      if (observation.refused) {
        pendingCodes = [];
        return ((pinnedReturn: "stop" | "continue") => pinnedReturn)("continue");
      }
      const nudgeCodes: string[] = [];
      let stop = false;
      for (const call of observation.calls) {
        if (call.toolName !== CODE_MODE_EXECUTE_NAME) continue;
        const prior = streaks.get(call.code);
        const count = prior != null && prior.result === call.result ? prior.count + 1 : 1;
        const nudged = prior?.nudged === true;
        streaks.set(call.code, { result: call.result, count, nudged });
        if (!nudged && count >= SPECIALIST_EXECUTE_NUDGE_AT && count < SPECIALIST_EXECUTE_STOP_AT) {
          nudgeCodes.push(call.code);
        }
        if (count >= SPECIALIST_EXECUTE_STOP_AT) stop = true;
      }
      pendingCodes = stop ? [] : nudgeCodes;
      return ((pinnedReturn: "stop" | "continue") => pinnedReturn)(stop ? "stop" : "continue");
    },
    takeNudges() {
      const codes = pendingCodes;
      pendingCodes = [];
      for (const code of codes) {
        const streak = streaks.get(code);
        if (streak) streaks.set(code, { ...streak, nudged: true });
      }
      return ((pinnedReturn: readonly string[]) => pinnedReturn)(
        codes.length > 0 ? [SPECIALIST_REPEATED_EXECUTE_NUDGE] : [],
      );
    },
  };
}
