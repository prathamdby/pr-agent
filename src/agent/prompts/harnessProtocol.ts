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
    "Investigate through `execute({ code })`. Each call is one QuickJS cell: fresh context, last expression is the return. Locals and functions die after the cell. `state` is JSON that persists across cells in this session. No functions, promises, or open resources in `state`.",
    "Installed host capabilities (only these):",
    renderGuestCatalogue(params.guest),
    `One cell may fire many host calls. Independent reads go in \`Promise.all\` (host in-flight ${CODE_MODE_HOST_IN_FLIGHT}; max ${CODE_MODE_MAX_TOOL_CALLS} calls per cell).`,
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
    "Banned in the cell: `fetch`, `require`, `import`, `process`, `fs`, timers.",
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
      "Do not submit from the cell. After investigation, call `submit_findings_report` once.",
    extra: [
      "Confirm `searchCodeIndex` hints with `await tools.readWorkspaceFile` inside `execute`. When the index returns `{ unavailable: true }`, use `listChangedFiles`, `searchWorkspace`, and `readWorkspaceFile` inside `execute`.",
    ],
  }),
  "",
  "## Investigation protocol",
  "Honor each installed `tools.*` rule for order, literal search, truncation, and blame. No tool reads the PR conversation, issues, or external URLs.",
  "- Start with `listChangedFiles`, then diffs, then focused reads.",
  "- Anchor every finding to the changed line that best supports it. For a cross-file issue, use the changed line that most directly exposes the problem.",
  "- Report only issues introduced or exposed by this PR; never file unrelated pre-existing issues.",
  "- If a host call refuses for path, size, or workspace reasons, work from what you have, note the limit, and do not loop on the same refused call.",
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
  cellBoundary:
    "Do not submit or publish from the cell. Use the active phase tool after investigation.",
  extra: [
    "Phase admission: recon may terminate only with `submit_specialist_brief`; judgment only with `publish_thread`; synthesis only with `publish_summary`. `execute` stays available in every phase.",
    "Confirm `searchCodeIndex` and `resolveSymbol` hints with `await tools.readWorkspaceFile` inside `execute` before naming a path or symbol.",
  ],
});

export const askInvestigationHarness = renderCodeModeHarness({
  guest: GUEST_CAPABILITY_SPECS,
  nativeTools: ["execute", "searchCodeIndex", "resolveLibraryId", "getLibraryDocs"],
  cellBoundary: "Do not answer from the cell. After investigation, reply with plain text.",
  extra: [
    "Confirm `searchCodeIndex` hints with `await tools.readWorkspaceFile` inside `execute`. When the index returns `{ unavailable: true }`, use `listChangedFiles`, `searchWorkspace`, and `readWorkspaceFile` inside `execute`.",
    "The workspace is a PR head checkout. No tool reads the PR conversation, issues, or external URLs.",
  ],
});

export const verificationInvestigationHarness = renderCodeModeHarness({
  guest: VERIFICATION_GUEST_SPECS,
  nativeTools: ["execute", "submitVerification"],
  cellBoundary: "Do not submit from the cell. After inspection, call `submitVerification` once.",
  extra: [
    "You do not have `listChangedFiles`, `getWorkspaceBlame`, `resolveSymbol`, `searchCodeIndex`, or Context7.",
  ],
});

export const descriptionNativeTooling = [
  "## Tools",
  "Call native tools directly. There is no `execute` cell.",
  "Installed: `listChangedFiles`, `readWorkspaceFile`, `searchWorkspace` (literal match), `getWorkspaceDiff`, `getWorkspaceBlame`, `resolveSymbol`, `submitDescription`.",
  "Start with `listChangedFiles`, then diffs, then focused reads. Blame only when authorship decides the description. Confirm `resolveSymbol` matches with `readWorkspaceFile` before citing.",
  "No tool reads the PR conversation, issues, or external URLs.",
].join("\n");

export const triageNativeTooling = [
  "## Tools",
  "Call native tools directly. There is no `execute` cell.",
  "Inspect with `readWorkspaceFile`, `searchWorkspace` (literal match, not regex), and `getWorkspaceDiff`.",
  "Edit only with `editWorkspaceFile` or `createWorkspaceFile`. Commit with `commitFix`. Finish with `submitTriage`.",
].join("\n");

export const noToolsTurnGuidance = "You have no tools. Reply with the required JSON only.";
