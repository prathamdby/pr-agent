/** GFM table cell: escape pipes/newlines, then HTML-sensitive characters. */
export function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function escapeTableHtml(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeTableCellContent(text: string): string {
  return escapeTableHtml(escapeTableCell(text));
}

export function escapeAlertBody(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line.replace(/^>/, "\\>")}`)
    .join("\n");
}

export function renderGitHubAlert(alertType: string, body: string): string {
  return `> [!${alertType}]\n${escapeAlertBody(body)}`;
}
