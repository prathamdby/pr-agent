import { withPrMutex } from "../../state/prMutex.ts";

export type ThreadMutationLock = <T>(apply: () => Promise<T>) => Promise<T>;

export function threadMutationLock(resourceKey: string) {
  return ((pinnedReturn: ThreadMutationLock) => pinnedReturn)((apply) =>
    withPrMutex(`threads:${resourceKey}`, apply),
  );
}
