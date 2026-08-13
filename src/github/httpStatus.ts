import * as v from "valibot";

const errorStatusSchema = v.object({ status: v.number() });

export function httpStatus(error: Error): number | undefined {
  const parsed = v.safeParse(errorStatusSchema, error);
  if (!parsed.success) return undefined;
  const status = parsed.output.status;
  return Number.isInteger(status) ? status : undefined;
}
