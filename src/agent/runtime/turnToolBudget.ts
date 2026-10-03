import type { BeforeToolCallResult, FinishTurn } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { PiSessionSendOptions } from "./types.js";

type BudgetToolResult = Pick<ToolResultMessage, "toolName" | "isError">;

/** Keep Core's finish-before-event ordering and reserved-tool budgets in one owner. */
export function createTurnToolBudget(
  opts: Pick<PiSessionSendOptions, "maxToolRounds" | "reservedTerminalTool">,
) {
  const reservedTerminalTool = opts.reservedTerminalTool;
  let investigationTurnCount = 0;
  let reservedTerminalSuccessCount = 0;
  let reservedTerminalAttemptCount = 0;
  let toolBudgetStopped = false;
  const turnContainsReservedTool = (toolResults: readonly BudgetToolResult[]): boolean => {
    if (reservedTerminalTool == null) return false;
    return toolResults.some((result) => result.toolName === reservedTerminalTool);
  };
  const isSuccessfulReservedTurn = (toolResults: readonly BudgetToolResult[]): boolean => {
    if (reservedTerminalTool == null) return false;
    return toolResults.some(
      (result) => result.toolName === reservedTerminalTool && !result.isError,
    );
  };

  // finishTurn precedes turn_end: include the current round without charging it twice.
  const finishTurn: FinishTurn = ({ toolResults }) => {
    if (opts.maxToolRounds == null) return undefined;
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
    if (toolBudgetStopped || roundsAfterThisTurn >= maxToolRounds) {
      if (
        reservedTerminalTool != null &&
        reservedTerminalSuccessCount === 0 &&
        investigationTurnCount < maxToolRounds
      ) {
        return undefined;
      }
      return { action: "end" };
    }
    return undefined;
  };

  function beforeToolCall(toolName: string): BeforeToolCallResult | undefined {
    if (opts.maxToolRounds != null && reservedTerminalTool != null) {
      if (toolName === reservedTerminalTool) {
        if (reservedTerminalSuccessCount > 0) {
          return {
            block: true,
            reason: `Reserved terminal ${reservedTerminalTool} already used this turn.`,
          };
        }
        if (reservedTerminalAttemptCount >= 2) {
          return {
            block: true,
            reason: `Reserved terminal ${reservedTerminalTool} attempt budget exhausted.`,
          };
        }
        return undefined;
      }
      if (investigationTurnCount >= opts.maxToolRounds) {
        return {
          block: true,
          reason: `Tool budget exhausted: only ${reservedTerminalTool} is allowed.`,
        };
      }
    }
    return undefined;
  }
  function observeTurn(toolResults: readonly BudgetToolResult[]): void {
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
      if (reservedTerminalSuccessCount > 0 && opts.maxToolRounds != null) {
        toolBudgetStopped = true;
      } else if (reservedTerminalAttemptCount >= 2 && opts.maxToolRounds != null) {
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
