import { WORK_QUEUES, type WorkType } from "./types.js";

/** Ask is the only unleased durable work type. Any other type takes a PR actor lease. */
export const UNLEASED_WORK_TYPES = ["ask"] as const satisfies readonly WorkType[];

const unleasedWorkTypes: ReadonlySet<string> = new Set(UNLEASED_WORK_TYPES);

function isWorkType(type: string): type is WorkType {
  return Object.prototype.hasOwnProperty.call(WORK_QUEUES, type);
}

export function leasedWorkQueues(): readonly string[] {
  const queues: string[] = [];
  for (const type of Object.keys(WORK_QUEUES)) {
    if (!isWorkType(type) || unleasedWorkTypes.has(type)) continue;
    queues.push(WORK_QUEUES[type]);
  }
  return queues;
}

/** Lease binding `define` attaches. Ask gets none. */
export function leaseBinding(
  type: WorkType,
  queue: string,
): { readonly prActorLease?: { readonly queue: string } } {
  if (unleasedWorkTypes.has(type)) return {};
  return { prActorLease: { queue } };
}
