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

function unescapeTableCell(text: string): string {
  return text.replace(/\\\|/g, "|");
}

/** Inline markdown used in review summary table cells → HTML for headerless tables. */
export function markdownInlineToHtml(text: string): string {
  return text.split("<br>").map(convertMarkdownInlineSegment).join("<br>");
}

function convertMarkdownInlineSegment(segment: string): string {
  let s = segment;
  s = s.replace(
    /\*\*\[((?:\\.|[^\]])*)\]\(([^)]+)\)\*\*/g,
    (_, title, url) =>
      `<strong><a href="${url}">${unescapeTableCell(title)}</a></strong>`,
  );
  s = s.replace(
    /\*\*((?:\\.|[^*])+)\*\*/g,
    (_, inner) => `<strong>${unescapeTableCell(inner)}</strong>`,
  );
  s = s.replace(/_((?:\\.|[^_])+)_/g, (_, inner) => {
    const body = unescapeTableCell(inner).replace(
      /`([^`]+)`/g,
      (_, code) => `<code>${code}</code>`,
    );
    return `<em>${body}</em>`;
  });
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  return unescapeTableCell(s);
}

/** Key-value table without a GFM header row (avoids the empty `| | |` header strip on GitHub). */
export function renderKeyValueTable(rows: ReadonlyArray<readonly [string, string]>): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td>${markdownInlineToHtml(label)}</td><td>${markdownInlineToHtml(value)}</td></tr>`,
    )
    .join("\n");
  return `<table>\n<tbody>\n${body}\n</tbody>\n</table>`;
}
