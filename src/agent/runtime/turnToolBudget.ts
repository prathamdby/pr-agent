import type { BeforeToolCallResult, FinishTurn } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { PiSessionSendOptions } from "./types.ts";

type BudgetToolResult = Pick<ToolResultMessage, "toolName" | "isError">;

export function createTurnToolBudget(
  opts: Pick<PiSessionSendOptions, "maxToolRounds" | "reservedTerminalTool" | "stopAtMs">,
) {
  const reservedTerminalTool = opts.reservedTerminalTool;
  const budgetEnforced = opts.maxToolRounds != null || opts.stopAtMs != null;
  let investigationTurnCount = 0;
  let reservedTerminalSuccessCount = 0;
  let reservedTerminalAttemptCount = 0;
  let toolBudgetStopped = false;
  let deadlineSubmitTurnGranted = false;
  const deadlineReached = () => opts.stopAtMs != null && Date.now() >= opts.stopAtMs;
  const turnContainsReservedTool = (toolResults: readonly BudgetToolResult[]) => {
    if (reservedTerminalTool == null) return ((pinnedReturn: boolean) => pinnedReturn)(false);
    return ((pinnedReturn: boolean) => pinnedReturn)(
      toolResults.some((result) => result.toolName === reservedTerminalTool),
    );
  };
  const isSuccessfulReservedTurn = (toolResults: readonly BudgetToolResult[]) => {
    if (reservedTerminalTool == null) return ((pinnedReturn: boolean) => pinnedReturn)(false);
    return ((pinnedReturn: boolean) => pinnedReturn)(
      toolResults.some((result) => result.toolName === reservedTerminalTool && !result.isError),
    );
  };

  const finishTurn: FinishTurn = ({ toolResults }) => {
    if (!budgetEnforced) return undefined;
    if (toolResults.length === 0) return undefined;
    if (isSuccessfulReservedTurn(toolResults)) {
      return { action: "end" };
    }
    if (turnContainsReservedTool(toolResults)) {
      if (reservedTerminalSuccessCount > 0) {
        return { action: "end" };
      }
      if (reservedTerminalAttemptCount + 1 >= 2) {
        return { action: "end" };
      }
      return undefined;
    }
    const maxToolRounds = opts.maxToolRounds;
    const roundsAfterThisTurn = investigationTurnCount + 1;
    const pastDeadline = deadlineReached();
    if (
      toolBudgetStopped ||
      pastDeadline ||
      (maxToolRounds != null && roundsAfterThisTurn >= maxToolRounds)
    ) {
      if (
        reservedTerminalTool != null &&
        reservedTerminalSuccessCount === 0 &&
        (maxToolRounds == null || investigationTurnCount < maxToolRounds) &&
        !(pastDeadline && deadlineSubmitTurnGranted)
      ) {
        if (pastDeadline) deadlineSubmitTurnGranted = true;
        return undefined;
      }
      if (pastDeadline) toolBudgetStopped = true;
      return { action: "end" };
    }
    return undefined;
  };

  function beforeToolCall(toolName: string) {
    if (budgetEnforced && reservedTerminalTool != null) {
      if (toolName === reservedTerminalTool) {
        if (reservedTerminalSuccessCount > 0) {
          return ((pinnedReturn: BeforeToolCallResult | undefined) => pinnedReturn)({
            block: true,
            reason: `Reserved terminal ${reservedTerminalTool} already used this turn.`,
          });
        }
        if (reservedTerminalAttemptCount >= 2) {
          return ((pinnedReturn: BeforeToolCallResult | undefined) => pinnedReturn)({
            block: true,
            reason: `Reserved terminal ${reservedTerminalTool} attempt budget exhausted.`,
          });
        }
        return ((pinnedReturn: BeforeToolCallResult | undefined) => pinnedReturn)(undefined);
      }
      if (
        deadlineReached() ||
        (opts.maxToolRounds != null && investigationTurnCount >= opts.maxToolRounds)
      ) {
        return ((pinnedReturn: BeforeToolCallResult | undefined) => pinnedReturn)({
          block: true,
          reason: `Tool budget exhausted: only ${reservedTerminalTool} is allowed.`,
        });
      }
    }
    return ((pinnedReturn: BeforeToolCallResult | undefined) => pinnedReturn)(undefined);
  }
  function observeTurn(toolResults: readonly BudgetToolResult[]) {
    if (toolResults.length === 0) return;
    if (isSuccessfulReservedTurn(toolResults)) {
      reservedTerminalAttemptCount += 1;
      reservedTerminalSuccessCount += 1;
      const hasNonReserved =
        reservedTerminalTool != null &&
        toolResults.some((result) => result.toolName !== reservedTerminalTool);
      if (hasNonReserved) {
        investigationTurnCount += 1;
      }
    } else if (turnContainsReservedTool(toolResults)) {
      reservedTerminalAttemptCount += 1;
      const hasNonReserved =
        reservedTerminalTool != null &&
        toolResults.some((result) => result.toolName !== reservedTerminalTool);
      if (hasNonReserved) {
        investigationTurnCount += 1;
      }
      if (reservedTerminalSuccessCount > 0 && budgetEnforced) {
        toolBudgetStopped = true;
      } else if (reservedTerminalAttemptCount >= 2 && budgetEnforced) {
        toolBudgetStopped = true;
      }
    } else {
      investigationTurnCount += 1;
      if (opts.maxToolRounds != null && investigationTurnCount >= opts.maxToolRounds) {
        if (reservedTerminalTool == null || reservedTerminalSuccessCount > 0) {
          toolBudgetStopped = true;
        } else if (investigationTurnCount > opts.maxToolRounds) {
          toolBudgetStopped = true;
        }
      }
    }
  }
  return {
    finishTurn,
    beforeToolCall,
    observeTurn,
    get stopped() {
      return toolBudgetStopped;
    },
  };
}
