export function httpStatus(error: unknown): number | undefined {
  return (error as { status?: number }).status;
}
