import { CODE_MODE_HOST_IN_FLIGHT, CODE_MODE_MAX_TOOL_CALLS } from "../../settings/index.ts";

export const CODE_MODE_WORKSPACE_TOOL_NAMES = [
  "listChangedFiles",
  "read_pinned",
  "searchWorkspace",
  "findFiles",
  "getWorkspaceDiff",
  "getWorkspaceBlame",
  "resolveSymbol",
] as const;

export type CodeModeWorkspaceToolName = (typeof CODE_MODE_WORKSPACE_TOOL_NAMES)[number];
export type CodeModeCapabilityExecutors =
  | ReadonlySet<string>
  | readonly string[]
  | Record<string, unknown>;

export type GuestCapabilitySpec = {
  readonly name: CodeModeWorkspaceToolName;
  readonly call: string;
  readonly rule: string;
};

const GUEST_CAPABILITY_SPEC_BY_NAME = {
  listChangedFiles: {
    call: "await tools.listChangedFiles({ continuation? })",
    rule: "Changed paths with status and checkout presence. Omit continuation for the first page, then pass the returned continuation until it is null. total is the admitted count. truncated means the pull request has changes beyond the admitted files. The call returns an object, and `files` is always the array.",
  },
  read_pinned: {
    call: "await tools.read_pinned({ path, startLine?, maxLines? })",
    rule: "Repo-relative path; use the window on long files. On truncation, read a narrower window, since the same call returns the same bytes. The call returns an object. `content` is a string on a delivered read, null when the path is deleted, and absent when the read is refused or spilled. A spill holds the excerpt in `tail`.",
  },
  searchWorkspace: {
    call: "await tools.searchWorkspace({ query, terms?, maxResults? })",
    rule: "Literal text, matched case-sensitively, not regex. `terms` adds literals and ranks files by how many they contain. On truncation, search for more specific text. The call returns an object, and `matches` is always the array. Each hit has `path`, `line`, and `text`. `files` exists only when `terms` has entries.",
  },
  findFiles: {
    call: "await tools.findFiles({ query, maxResults? })",
    rule: "Fuzzy, case-insensitive path lookup, best match first. Paths only; read before citing. The call returns an object, and `paths` is always the string array.",
  },
  getWorkspaceDiff: {
    call: "await tools.getWorkspaceDiff({ path })",
    rule: "PR base-to-head unified diff for one path. The call returns an object, and `diff` is always the unified-diff string, including when that string is empty. `availability` is `available`, `unchanged`, or `unavailable`. An empty `diff` does not fail the call and does not prove the path is unchanged. `unchanged` requires a complete changed-file list. A thrown host error is the failure.",
  },
  getWorkspaceBlame: {
    call: "await tools.getWorkspaceBlame({ path })",
    rule: "Whole-file blame. Use when who changed a line, or when, decides the question. The call returns an object, and `blame` is a string, or null when the path is deleted or refused.",
  },
  resolveSymbol: {
    call: "await tools.resolveSymbol({ name, maxResults? })",
    rule: "Definition hints, not evidence. Confirm with read_pinned before citing. The call returns an object, and `matches` is always the array. Each entry has `path`, `line`, and `kind`.",
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
) {
  const names = capabilityNameSet(installed);
  return ((pinnedReturn: readonly GuestCapabilitySpec[]) => pinnedReturn)(
    GUEST_CAPABILITY_SPECS.filter((spec) => names.has(spec.name)),
  );
}

export function renderGuestCatalogue(specs: readonly GuestCapabilitySpec[]) {
  return ((pinnedReturn: string) => pinnedReturn)(
    specs.map((spec) => `- \`${spec.call}\`. ${spec.rule}`).join("\n"),
  );
}

const FAN_OUT_CALLS: readonly {
  readonly binding: string;
  readonly call: string;
  readonly name: CodeModeWorkspaceToolName;
}[] = [
  { binding: "page", call: "tools.listChangedFiles()", name: "listChangedFiles" },
  {
    binding: "src",
    call: 'tools.read_pinned({ path: "src/app.ts", startLine: 1, maxLines: 80 })',
    name: "read_pinned",
  },
  {
    binding: "hits",
    call: 'tools.searchWorkspace({ query: "exportedName" })',
    name: "searchWorkspace",
  },
  {
    binding: "patch",
    call: 'tools.getWorkspaceDiff({ path: "src/app.ts" })',
    name: "getWorkspaceDiff",
  },
  {
    binding: "annotated",
    call: 'tools.getWorkspaceBlame({ path: "src/app.ts" })',
    name: "getWorkspaceBlame",
  },
];

const SHORT_FAN_OUT = new Set<CodeModeWorkspaceToolName>([
  "listChangedFiles",
  "read_pinned",
  "searchWorkspace",
  "getWorkspaceDiff",
]);

function collectFanOutCalls(
  specs: readonly GuestCapabilitySpec[],
  allowed: ReadonlySet<CodeModeWorkspaceToolName>,
) {
  const installed = new Set(specs.map((spec) => spec.name));
  const bindings: string[] = [];
  const calls: string[] = [];
  for (const row of FAN_OUT_CALLS) {
    if (!installed.has(row.name) || !allowed.has(row.name)) continue;
    if (calls.length >= CODE_MODE_HOST_IN_FLIGHT) break;
    bindings.push(row.binding);
    calls.push(row.call);
  }
  return ((pinnedReturn: { readonly bindings: string[]; readonly calls: string[] }) =>
    pinnedReturn)({ bindings, calls });
}

function renderPromiseAll(bindings: readonly string[], calls: readonly string[]) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      `const [${bindings.join(", ")}] = await Promise.all([`,
      ...calls.map((call) => `  ${call},`),
      "]);",
    ].join("\n"),
  );
}

export function renderFanOutExampleShort(specs: readonly GuestCapabilitySpec[]) {
  const { bindings, calls } = collectFanOutCalls(specs, SHORT_FAN_OUT);
  return ((pinnedReturn: string) => pinnedReturn)(
    calls.length === 0 ? "" : renderPromiseAll(bindings, calls),
  );
}

export function renderFanOutExample(specs: readonly GuestCapabilitySpec[]) {
  const names = new Set(specs.map((spec) => spec.name));
  const { bindings, calls } = collectFanOutCalls(specs, names);
  if (calls.length === 0) return ((pinnedReturn: string) => pinnedReturn)("");

  const lines = [renderPromiseAll(bindings, calls)];

  if (names.has("resolveSymbol")) {
    lines.push('const sym = await tools.resolveSymbol({ name: "exportedName" });');
    if (names.has("read_pinned")) {
      lines.push("if (sym.matches[0]) {");
      lines.push("  await tools.read_pinned({");
      lines.push("    path: sym.matches[0].path,");
      lines.push("    startLine: sym.matches[0].line,");
      lines.push("    maxLines: 40,");
      lines.push("  });");
      lines.push("}");
    }
  }

  if (bindings.includes("page")) {
    lines.push("state.changed = page.files.map((f) => f.path);");
  } else if (names.has("read_pinned")) {
    lines.push('state.seen = { path: "src/app.ts" };');
  }

  const bound = new Set(bindings);
  const resultFields: string[] = [];
  if (bound.has("page")) resultFields.push("n: page.files.length");
  if (bound.has("src"))
    resultFields.push('srcBytes: typeof src.content === "string" ? src.content.length : 0');
  if (bound.has("hits")) resultFields.push("hits: hits.matches.length");
  if (bound.has("patch"))
    resultFields.push("diffBytes: patch.diff.length", "availability: patch.availability");
  if (bound.has("annotated"))
    resultFields.push(
      'blameBytes: typeof annotated.blame === "string" ? annotated.blame.length : 0',
    );
  lines.push(resultFields.length > 0 ? `({ ${resultFields.join(", ")} })` : "({ done: true })");

  return ((pinnedReturn: string) => pinnedReturn)(lines.join("\n"));
}

export function renderExecuteDescription(capabilities: CodeModeCapabilityExecutors) {
  const specs = installedGuestCapabilities(capabilities);
  const catalogue = renderGuestCatalogue(specs);
  const example = renderFanOutExample(specs);
  const parts = [
    "Run one JavaScript script against the PR head checkout in the codemode sandbox. Each call starts a fresh context. Locals and functions end with the script. The last expression is the return value. Each call is independent; return compact summaries and only the excerpts a conclusion needs.",
    `Host calls are the installed \`tools.*\` names below, at most ${CODE_MODE_MAX_TOOL_CALLS} per script. \`Promise.all\` overlaps independent reads; the host admits ${CODE_MODE_HOST_IN_FLIGHT} in flight. \`fetch\`, \`require\`, \`import\`, \`process\`, \`fs\`, and timers are unavailable.`,
    'Each host result keeps its declared fields plus `coverage` and `truncation`. Truncated strings stay strings, and the omitted bytes are described in `truncation`. `failureKind: "SEARCH_TRUNCATED"` marks any result the host cut short, including file reads and diffs, not only searches. A truncated or refused result cannot prove absence. `availability: "unavailable"` does not prove the path is unchanged.',
    "The script's return value enters your context, so return compact summaries and only the excerpts a conclusion needs.",
    "Submit, publish, and give the final ask reply through sibling native tools or the next assistant message, not from the script.",
  ];
  if (catalogue.length > 0) {
    parts.push(`Installed host capabilities:\n${catalogue}`);
  }
  if (example.length > 0) {
    parts.push(`Example: one script, many tool calls.\n\`\`\`js\n${example}\n\`\`\``);
  }
  return ((pinnedReturn: string) => pinnedReturn)(parts.join("\n\n"));
}

function capabilityNameSet(
  installed: ReadonlySet<string> | readonly string[] | CodeModeCapabilityExecutors,
) {
  if (installed instanceof Set)
    return ((pinnedReturn: ReadonlySet<string>) => pinnedReturn)(installed);
  if (Array.isArray(installed))
    return ((pinnedReturn: ReadonlySet<string>) => pinnedReturn)(new Set(installed));
  return ((pinnedReturn: ReadonlySet<string>) => pinnedReturn)(
    new Set(
      Object.entries(installed)
        .filter(([, executor]) => executor)
        .map(([name]) => name),
    ),
  );
}

export const nativeToolCallingGuidance = "Call native tools directly. There is no `codemode` cell.";

export const obstacleReportGuidance =
  "When a tool, prompt, input, or instruction blocks or degrades the step you are on, call `report_obstacle` once, then continue. Do not call it for a finding, ordinary uncertainty, or to reach another reviewer.";

export const unavailableConversationToolsGuidance =
  "No tool reads the PR conversation, issues, or external URLs.";

export function renderCodeModeHarness(params: {
  readonly guest: readonly GuestCapabilitySpec[];
  readonly nativeTools: readonly string[];
  readonly cellBoundary: string;
  readonly extra?: readonly string[];
}) {
  const example = renderFanOutExampleShort(params.guest);
  const lines = [
    "## Harness",
    "Investigate through `codemode({ code })`. Each call is one QuickJS cell: fresh context, and the last expression is the return. Locals and functions end with the cell; `state` is JSON that persists across cells in this session, so it holds plain data only.",
    "Installed host capabilities (only these):",
    renderGuestCatalogue(params.guest),
    `One cell can make many host calls, so batch independent reads in \`Promise.all\` (host in-flight ${CODE_MODE_HOST_IN_FLIGHT}; max ${CODE_MODE_MAX_TOOL_CALLS} calls per cell).`,
  ];
  if (example.length > 0) {
    lines.push(
      "```js",
      example,
      "```",
      "The `codemode` tool description has a longer cell that also writes `state` and follows symbol hints.",
    );
  }
  lines.push(
    "Each host result keeps declared fields plus `coverage` and `truncation`. Truncated strings stay strings. A truncated or refused result cannot prove absence.",
    "Unavailable in the cell: `fetch`, `require`, `import`, `process`, `fs`, timers.",
    `Native tools you can call: ${params.nativeTools.map((name) => `\`${name}\``).join(", ")}. ${params.cellBoundary}`,
  );
  if (params.extra?.length) {
    lines.push(...params.extra);
  }
  lines.push(obstacleReportGuidance);
  return ((pinnedReturn: string) => pinnedReturn)(lines.join("\n"));
}

export const specialistInvestigationHarness = [
  renderCodeModeHarness({
    guest: GUEST_CAPABILITY_SPECS,
    nativeTools: ["codemode", "report_obstacle", "submit_findings_report"],
    cellBoundary:
      "Submitting happens outside the cell: after investigation, call `submit_findings_report`.",
  }),
  "",
  "## Investigation protocol",
  `The installed \`tools.*\` rules above cover literal search, truncation, and blame. ${unavailableConversationToolsGuidance}`,
  "- `listChangedFiles` gives the paths one page at a time. Pass `continuation` until it is null before treating the change set as listed. Diffs show what changed and cost less than whole files. Focused reads supply the surrounding context a diff lacks.",
  "- Anchor every finding to the changed line that best supports it. For a cross-file issue, use the changed line that most directly exposes the problem.",
  "- Findings are issues this PR introduces or exposes. Pre-existing issues the PR does not touch belong to a different review.",
  "- When a host call refuses for path, size, or workspace reasons, the same call refuses again; work from what you have and record the limit in `notes`.",
  "- Search for an existing behavior with `searchWorkspace`. Set `query` to the domain word. Set `terms` to three separate literals, the other casing, the other word form such as singular or plural, and one distinctive literal from the new body. Read the file the diff modifies and look for an existing function that already does the job. Read each promising hit with `read_pinned`. `resolveSymbol` is only a hint, and the index covers TypeScript, JavaScript, and Python.",
  "- Before you treat a symbol as unused, call `searchWorkspace` with `query` set to the bare name and `terms` set to that name inside double quotes and that name inside single quotes. The tool has no exclude flag. In the cell, discard matches that are the definition or that sit on a test path. A result with `truncated` set proves neither that the behavior is new nor that the symbol is unused.",
  "- When the diff adds a file, call `findFiles` with that directory in `query` and read the sibling that owns the same job.",
].join("\n");
