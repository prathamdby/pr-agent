export function firstNonEmptyLine(text: string): string {
  return text.match(/^.*\S.*$/m)?.[0] ?? "";
}
