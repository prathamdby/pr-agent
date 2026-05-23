/** GFM table cell: escape pipes/newlines, then HTML-sensitive characters. */
export function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function escapeTableHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeHtmlAttr(text: string): string {
  return escapeTableHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function escapeTableCellContent(text: string): string {
  return escapeTableHtml(escapeTableCell(text));
}

/** Plain text in HTML table cells (no GFM pipe escaping). */
export function escapeTablePlainCell(text: string): string {
  return escapeTableHtml(text.replace(/\r?\n/g, " "));
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

export function renderTableStrong(text: string): string {
  return `<strong>${escapeTableHtml(text)}</strong>`;
}

export function renderTableLink(title: string, href: string): string {
  return `<strong><a href="${escapeHtmlAttr(href)}">${escapeTableHtml(title)}</a></strong>`;
}

export function renderTableEm(text: string): string {
  return `<em>${escapeTableHtml(text)}</em>`;
}

export function renderTableCode(text: string): string {
  return `<code>${escapeTableHtml(text)}</code>`;
}

export function renderTableLocationMeta(marker: string, file: string, lineRange: string): string {
  return `<em>${escapeTableHtml(marker)} · ${renderTableCode(file)} · ${escapeTableHtml(lineRange)}</em>`;
}

/** Key-value table without a GFM header row (avoids the empty `| | |` header strip on GitHub). */
export function renderKeyValueTable(rows: ReadonlyArray<readonly [string, string]>): string {
  const body = rows
    .map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`)
    .join("\n");
  return `<table>\n<tbody>\n${body}\n</tbody>\n</table>`;
}
