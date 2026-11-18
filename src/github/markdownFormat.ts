export function escapeTableCell(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    text.replace(/\|/g, "\\|").replace(/\r?\n/g, " "),
  );
}

export function escapeTableHtml(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
}

function escapeHtmlAttr(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    escapeTableHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
  );
}

export function escapeTableCellContent(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(escapeTableHtml(escapeTableCell(text)));
}

export function escapeTablePlainCell(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(escapeTableHtml(text.replace(/\r?\n/g, " ")));
}

export function escapeAlertBody(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => `> ${line.replace(/^>/, "\\>")}`)
      .join("\n"),
  );
}

export function renderGitHubAlert(alertType: string, body: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`> [!${alertType}]\n${escapeAlertBody(body)}`);
}

export function renderTableStrong(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`<strong>${escapeTableHtml(text)}</strong>`);
}

export function renderTableLink(title: string, href: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `<strong><a href="${escapeHtmlAttr(href)}">${escapeTableHtml(title)}</a></strong>`,
  );
}

export function renderInlineCodeLink(label: string, href: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `<a href="${escapeHtmlAttr(href)}">${renderTableCode(label)}</a>`,
  );
}

export function renderTableEm(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`<em>${escapeTableHtml(text)}</em>`);
}

export function renderTableCode(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`<code>${escapeTableHtml(text)}</code>`);
}

export function renderTableLocationMeta(marker: string, file: string, lineRange: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `<em>${escapeTableHtml(marker)} · ${renderTableCode(file)} · ${escapeTableHtml(lineRange)}</em>`,
  );
}

export function renderKeyValueTable(rows: ReadonlyArray<readonly [string, string]>) {
  const body = rows
    .map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`)
    .join("\n");
  return ((pinnedReturn: string) => pinnedReturn)(`<table>\n<tbody>\n${body}\n</tbody>\n</table>`);
}
