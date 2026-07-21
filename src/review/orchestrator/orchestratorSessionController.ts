/**
 * Typed session-health controller for an orchestrated review run.
 * Degraded health covers recon/synthesis death (no further orchestrator sends).
 * Deadline and supersede stay on {@link RunAbortScope}; coverage notes stay on the finalizer.
 */
export type OrchestratorSessionHealth =
  | { readonly kind: "healthy" }
  | { readonly kind: "degraded" };

export type OrchestratorSessionController = {
  readonly markDegraded: () => void;
  readonly isDegraded: () => boolean;
  /** False once recon/judgment/synthesis degradation forbids further orchestrator sends. */
  readonly canSendOrchestrator: () => boolean;
};

export function createOrchestratorSessionController(): OrchestratorSessionController {
  let health: OrchestratorSessionHealth = { kind: "healthy" };

  return {
    markDegraded: () => {
      health = { kind: "degraded" };
    },
    isDegraded: () => health.kind === "degraded",
    canSendOrchestrator: () => health.kind === "healthy",
  };
}
