import type { SpecialistHandover } from "../run/reviewRunMetrics.ts";
import type { AcceptedPlacement } from "./orchestratorTypes.ts";

export function measureSpecialistHandover(input: {
  readonly handoverPaths: ReadonlySet<string>;
  readonly riskAreaFiles: ReadonlySet<string>;
  readonly specialistOpenedPaths: readonly (readonly string[])[];
  readonly accepted: readonly AcceptedPlacement[];
}): SpecialistHandover {
  let specialistReadCount = 0;
  let specialistRereadCount = 0;
  const rereadHandoverPaths = new Set<string>();
  for (const opened of input.specialistOpenedPaths) {
    for (const path of new Set(opened)) {
      specialistReadCount += 1;
      if (!input.handoverPaths.has(path)) continue;
      specialistRereadCount += 1;
      rereadHandoverPaths.add(path);
    }
  }
  return {
    specialistReadCount,
    specialistRereadCount,
    handoverRereadPathCount: rereadHandoverPaths.size,
    acceptedFindingCount: input.accepted.length,
    acceptedFindingInRiskAreaCount: input.accepted.filter((entry) =>
      input.riskAreaFiles.has(entry.placement.finding.file),
    ).length,
  };
}
