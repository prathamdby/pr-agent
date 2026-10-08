import { CODE_MODE_HOST_IN_FLIGHT, CODE_MODE_MAX_TOOL_CALLS } from "../../settings/index.js";
import {
  CODE_MODE_WORKSPACE_TOOL_NAMES,
  type CodeModeCapabilityExecutors,
  type CodeModeWorkspaceToolName,
} from "./types.js";

export type GuestCapabilitySpec = {
  readonly name: CodeModeWorkspaceToolName;
  readonly call: string;
  readonly rule: string;
};

const GUEST_CAPABILITY_SPEC_BY_NAME = {
  listChangedFiles: {
    call: "await tools.listChangedFiles()",
    rule: "Changed paths with status and checkout presence; other calls take paths from it. `truncated` means the list is incomplete.",
  },
  readWorkspaceFile: {
    call: "await tools.readWorkspaceFile({ path, startLine?, maxLines? })",
    rule: "Repo-relative path; use the window on long files. On truncation, read a narrower window, since the same call returns the same bytes.",
  },
  searchWorkspace: {
    call: "await tools.searchWorkspace({ query, maxResults? })",
    rule: "Literal git grep, not regex. On truncation, search for more specific text.",
  },
  getWorkspaceDiff: {
    call: "await tools.getWorkspaceDiff({ path })",
    rule: "PR unified diff for one path; cheaper than reading the whole file.",
  },
  getWorkspaceBlame: {
    call: "await tools.getWorkspaceBlame({ path })",
    rule: "Whole-file blame. Use when who changed a line, or when, decides the question.",
  },
  resolveSymbol: {
    call: "await tools.resolveSymbol({ name, maxResults? })",
    rule: "Definition hints, not evidence. Confirm with readWorkspaceFile before citing.",
  },
} as const satisfies Record<
  CodeModeWorkspaceToolName,
  { readonly call: string; readonly rule: string }
>;

export const GUEST_CAPABILITY_SPECS: readonly GuestCapabilitySpec[] =
  CODE_MODE_WORKSPACE_TOOL_NAMES.map((name) => ({
    name,
    call: GUEST_CAPABILITY_SPEC_BY_NAME[name].call,
    rule: GUEST_CAPABILITY_SPEC_BY_NAME[name].rule,
  }));

export function installedGuestCapabilities(
  installed: ReadonlySet<string> | readonly string[] | CodeModeCapabilityExecutors,
): readonly GuestCapabilitySpec[] {
  const names = capabilityNameSet(installed);
  return GUEST_CAPABILITY_SPECS.filter((spec) => names.has(spec.name));
}

export function renderGuestCatalogue(specs: readonly GuestCapabilitySpec[]): string {
  return specs.map((spec) => `- \`${spec.call}\`. ${spec.rule}`).join("\n");
}

const FAN_OUT_CALLS: readonly {
  readonly binding: string;
  readonly call: string;
  readonly name: CodeModeWorkspaceToolName;
}[] = [
  { binding: "files", call: "tools.listChangedFiles()", name: "listChangedFiles" },
  {
    binding: "src",
    call: 'tools.readWorkspaceFile({ path: "src/app.ts", startLine: 1, maxLines: 80 })',
    name: "readWorkspaceFile",
  },
  {
    binding: "hits",
    call: 'tools.searchWorkspace({ query: "exportedName" })',
    name: "searchWorkspace",
  },
  {
    binding: "diff",
    call: 'tools.getWorkspaceDiff({ path: "src/app.ts" })',
    name: "getWorkspaceDiff",
  },
  {
    binding: "blame",
    call: 'tools.getWorkspaceBlame({ path: "src/app.ts" })',
    name: "getWorkspaceBlame",
  },
];

const SHORT_FAN_OUT = new Set<CodeModeWorkspaceToolName>([
  "listChangedFiles",
  "readWorkspaceFile",
  "searchWorkspace",
  "getWorkspaceDiff",
]);

function collectFanOutCalls(
  specs: readonly GuestCapabilitySpec[],
  allowed: ReadonlySet<CodeModeWorkspaceToolName>,
): { readonly bindings: string[]; readonly calls: string[] } {
  const installed = new Set(specs.map((spec) => spec.name));
  const bindings: string[] = [];
  const calls: string[] = [];
  for (const row of FAN_OUT_CALLS) {
    if (!installed.has(row.name) || !allowed.has(row.name)) continue;
    if (calls.length >= CODE_MODE_HOST_IN_FLIGHT) break;
    bindings.push(row.binding);
    calls.push(row.call);
  }
  return { bindings, calls };
}

function renderPromiseAll(bindings: readonly string[], calls: readonly string[]): string {
  return [
    `const [${bindings.join(", ")}] = await Promise.all([`,
    ...calls.map((call) => `  ${call},`),
    "]);",
  ].join("\n");
}

export function renderFanOutExampleShort(specs: readonly GuestCapabilitySpec[]): string {
  const { bindings, calls } = collectFanOutCalls(specs, SHORT_FAN_OUT);
  return calls.length === 0 ? "" : renderPromiseAll(bindings, calls);
}

export function renderFanOutExample(specs: readonly GuestCapabilitySpec[]): string {
  const names = new Set(specs.map((spec) => spec.name));
  const { bindings, calls } = collectFanOutCalls(specs, names);
  if (calls.length === 0) return "";

  const lines = [renderPromiseAll(bindings, calls)];

  if (names.has("resolveSymbol")) {
    lines.push('const sym = await tools.resolveSymbol({ name: "exportedName" });');
    if (names.has("readWorkspaceFile")) {
      lines.push("if (sym.matches[0]) {");
      lines.push("  await tools.readWorkspaceFile({");
      lines.push("    path: sym.matches[0].path,");
      lines.push("    startLine: sym.matches[0].line,");
      lines.push("    maxLines: 40,");
      lines.push("  });");
      lines.push("}");
    }
  }

  if (names.has("listChangedFiles")) {
    lines.push("state.changed = files.files.map((f) => f.path);");
  } else if (names.has("readWorkspaceFile")) {
    lines.push('state.seen = { path: "src/app.ts" };');
  }

  const resultFields: string[] = [];
  if (names.has("listChangedFiles")) resultFields.push("n: files.files.length");
  if (names.has("readWorkspaceFile")) resultFields.push("srcTrunc: src.truncation");
  if (names.has("searchWorkspace")) resultFields.push("hits: hits.matches.length");
  if (names.has("getWorkspaceDiff")) resultFields.push("diffTrunc: diff.truncation");
  lines.push(resultFields.length > 0 ? `({ ${resultFields.join(", ")} })` : "({ done: true })");

  return lines.join("\n");
}

export function renderExecuteDescription(capabilities: CodeModeCapabilityExecutors): string {
  const specs = installedGuestCapabilities(capabilities);
  const catalogue = renderGuestCatalogue(specs);
  const example = renderFanOutExample(specs);
  const parts = [
    "Run one QuickJS cell of JavaScript against the PR head checkout. Each call starts a fresh context: locals and functions end with the cell, and the last expression is the return value. `state` is JSON investigation data that persists across cells in this session, so it holds plain data only, no functions, promises, or open resources.",
    `Host calls are the installed \`tools.*\` names below, at most ${CODE_MODE_MAX_TOOL_CALLS} per cell. \`Promise.all\` overlaps independent reads; the host admits ${CODE_MODE_HOST_IN_FLIGHT} in flight. \`fetch\`, \`require\`, \`import\`, \`process\`, \`fs\`, and timers are unavailable.`,
    'Each host result keeps its declared fields plus `coverage` and `truncation`. Truncated strings stay strings, and the omitted bytes are described in `truncation`. `failureKind: "SEARCH_TRUNCATED"` marks any result the host cut short, including file reads and diffs, not only searches. A truncated or refused result cannot prove absence.',
    "The cell's return value enters your context, so return compact summaries and only the excerpts a conclusion needs.",
    "Submitting, publishing, and the final ask reply happen through sibling native tools or the next assistant message, never from the cell.",
  ];
  if (catalogue.length > 0) {
    parts.push(`Installed host capabilities:\n${catalogue}`);
  }
  if (example.length > 0) {
    parts.push(`Example: one cell, many host calls.\n\`\`\`js\n${example}\n\`\`\``);
  }
  return parts.join("\n\n");
}

function capabilityNameSet(
  installed: ReadonlySet<string> | readonly string[] | CodeModeCapabilityExecutors,
): ReadonlySet<string> {
  if (installed instanceof Set) return installed;
  if (Array.isArray(installed)) return new Set(installed);
  return new Set(
    Object.entries(installed)
      .filter(([, executor]) => executor)
      .map(([name]) => name),
  );
}
