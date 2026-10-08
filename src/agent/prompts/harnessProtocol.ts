import {
  GUEST_CAPABILITY_SPECS,
  renderFanOutExampleShort,
  renderGuestCatalogue,
  type GuestCapabilitySpec,
} from "../codemode/guestCatalogue.js";
import { CODE_MODE_HOST_IN_FLIGHT, CODE_MODE_MAX_TOOL_CALLS } from "../../settings/index.js";

const VERIFICATION_GUEST_NAMES: ReadonlySet<string> = new Set([
  "readWorkspaceFile",
  "searchWorkspace",
  "getWorkspaceDiff",
]);

export const VERIFICATION_GUEST_SPECS: readonly GuestCapabilitySpec[] =
  GUEST_CAPABILITY_SPECS.filter((spec) => VERIFICATION_GUEST_NAMES.has(spec.name));

export function renderCodeModeHarness(params: {
  readonly guest: readonly GuestCapabilitySpec[];
  readonly nativeTools: readonly string[];
  readonly cellBoundary: string;
  readonly extra?: readonly string[];
}): string {
  const example = renderFanOutExampleShort(params.guest);
  const lines = [
    "## Harness",
    "Investigate through `execute({ code })`. Each call is one QuickJS cell: fresh context, and the last expression is the return. Locals and functions end with the cell; `state` is JSON that persists across cells in this session, so it holds plain data only.",
    "Installed host capabilities (only these):",
    renderGuestCatalogue(params.guest),
    `One cell can make many host calls, so batch independent reads in \`Promise.all\` (host in-flight ${CODE_MODE_HOST_IN_FLIGHT}; max ${CODE_MODE_MAX_TOOL_CALLS} calls per cell).`,
  ];
  if (example.length > 0) {
    lines.push(
      "```js",
      example,
      "```",
      "The `execute` tool description has a longer cell that also writes `state` and follows symbol hints.",
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
  return lines.join("\n");
}

export const specialistInvestigationHarness = [
  renderCodeModeHarness({
    guest: GUEST_CAPABILITY_SPECS,
    nativeTools: [
      "execute",
      "searchCodeIndex",
      "resolveLibraryId",
      "getLibraryDocs",
      "submit_findings_report",
    ],
    cellBoundary:
      "Submitting happens outside the cell: after investigation, call `submit_findings_report`.",
    extra: [
      "Confirm `searchCodeIndex` hints with `await tools.readWorkspaceFile` inside `execute`. When the index returns `{ unavailable: true }`, use `listChangedFiles`, `searchWorkspace`, and `readWorkspaceFile` inside `execute`.",
    ],
  }),
  "",
  "## Investigation protocol",
  "The installed `tools.*` rules above cover literal search, truncation, and blame. No tool reads the PR conversation, issues, or external URLs.",
  "- `listChangedFiles` gives the paths; diffs show what changed and cost less than whole files; focused reads supply the surrounding context a diff lacks.",
  "- Anchor every finding to the changed line that best supports it. For a cross-file issue, use the changed line that most directly exposes the problem.",
  "- Findings are issues this PR introduces or exposes. Pre-existing issues the PR does not touch belong to a different review.",
  "- When a host call refuses for path, size, or workspace reasons, the same call refuses again; work from what you have and record the limit in `notes`.",
].join("\n");

export const orchestratorHarness = renderCodeModeHarness({
  guest: GUEST_CAPABILITY_SPECS,
  nativeTools: [
    "execute",
    "searchCodeIndex",
    "resolveLibraryId",
    "getLibraryDocs",
    "submit_specialist_brief",
    "publish_thread",
    "publish_summary",
  ],
  cellBoundary: "Submitting and publishing happen outside the cell, through the active phase tool.",
  extra: [
    "Each phase accepts one terminal tool: recon `submit_specialist_brief`, judgment `publish_thread`, synthesis `publish_summary`. The others return a wrong-phase error. `execute` stays available in every phase.",
    "Confirm `searchCodeIndex` and `resolveSymbol` hints with `await tools.readWorkspaceFile` inside `execute` before naming a path or symbol.",
  ],
});

export const askInvestigationHarness = renderCodeModeHarness({
  guest: GUEST_CAPABILITY_SPECS,
  nativeTools: ["execute", "searchCodeIndex", "resolveLibraryId", "getLibraryDocs"],
  cellBoundary: "The answer goes in your final plain-text reply, not in a cell.",
  extra: [
    "Confirm `searchCodeIndex` hints with `await tools.readWorkspaceFile` inside `execute`. When the index returns `{ unavailable: true }`, use `listChangedFiles`, `searchWorkspace`, and `readWorkspaceFile` inside `execute`.",
    "The workspace is a PR head checkout. No tool reads the PR conversation, issues, or external URLs.",
  ],
});

export const verificationInvestigationHarness = renderCodeModeHarness({
  guest: VERIFICATION_GUEST_SPECS,
  nativeTools: ["execute", "submitVerification"],
  cellBoundary: "Submitting happens outside the cell: after inspection, call `submitVerification`.",
  extra: [
    "This profile has no `listChangedFiles`, `getWorkspaceBlame`, `resolveSymbol`, `searchCodeIndex`, or Context7; the inventory names the paths to inspect.",
  ],
});

export const descriptionNativeTooling = [
  "## Tools",
  "Call native tools directly. There is no `execute` cell.",
  "Installed: `listChangedFiles`, `readWorkspaceFile`, `searchWorkspace` (literal match), `getWorkspaceDiff`, `getWorkspaceBlame`, `resolveSymbol`, `submitDescription`.",
  "`listChangedFiles` gives the paths; diffs show what changed and cost less than whole files; focused reads supply context. Blame is for when authorship decides the description. `resolveSymbol` matches are hints until `readWorkspaceFile` confirms them.",
  "No tool reads the PR conversation, issues, or external URLs.",
].join("\n");

export const triageNativeTooling = [
  "## Tools",
  "Call native tools directly. There is no `execute` cell.",
  "Inspect with `readWorkspaceFile`, `searchWorkspace` (literal match, not regex), and `getWorkspaceDiff`.",
  "Change files with `editWorkspaceFile` or `createWorkspaceFile`, commit each fix with `commitFix`, and record the result with `submitTriage`. These are the only write paths; edits outside the files the inventory names are refused.",
].join("\n");

export const noToolsTurnGuidance =
  "This turn has no tools. The server parses your reply as JSON, so reply with only the JSON object described below.";
