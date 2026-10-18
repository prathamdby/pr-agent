import {
  GUEST_CAPABILITY_SPECS,
  renderFanOutExampleShort,
  renderGuestCatalogue,
  type GuestCapabilitySpec,
} from "../../agent/codemode/guestCatalogue.ts";
import { CODE_MODE_HOST_IN_FLIGHT, CODE_MODE_MAX_TOOL_CALLS } from "../../settings/index.ts";

export const nativeToolCallingGuidance = "Call native tools directly. There is no `execute` cell.";

export const unavailableConversationToolsGuidance =
  "No tool reads the PR conversation, issues, or external URLs.";

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
    nativeTools: ["execute", "resolveLibraryId", "getLibraryDocs", "submit_findings_report"],
    cellBoundary:
      "Submitting happens outside the cell: after investigation, call `submit_findings_report`.",
  }),
  "",
  "## Investigation protocol",
  `The installed \`tools.*\` rules above cover literal search, truncation, and blame. ${unavailableConversationToolsGuidance}`,
  "- `listChangedFiles` gives the paths; diffs show what changed and cost less than whole files; focused reads supply the surrounding context a diff lacks.",
  "- Anchor every finding to the changed line that best supports it. For a cross-file issue, use the changed line that most directly exposes the problem.",
  "- Findings are issues this PR introduces or exposes. Pre-existing issues the PR does not touch belong to a different review.",
  "- When a host call refuses for path, size, or workspace reasons, the same call refuses again; work from what you have and record the limit in `notes`.",
].join("\n");
