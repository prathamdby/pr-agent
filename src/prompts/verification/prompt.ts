import {
  GUEST_CAPABILITY_SPECS,
  type GuestCapabilitySpec,
} from "../../agent/codemode/guestCatalogue.js";
import { renderCodeModeHarness } from "../shared/tools.js";

const VERIFICATION_GUEST_NAMES: ReadonlySet<string> = new Set([
  "readWorkspaceFile",
  "searchWorkspace",
  "getWorkspaceDiff",
]);

export const VERIFICATION_GUEST_SPECS: readonly GuestCapabilitySpec[] =
  GUEST_CAPABILITY_SPECS.filter((spec) => VERIFICATION_GUEST_NAMES.has(spec.name));

export const verificationInvestigationHarness = renderCodeModeHarness({
  guest: VERIFICATION_GUEST_SPECS,
  nativeTools: ["execute", "submitVerification"],
  cellBoundary: "Submitting happens outside the cell: after inspection, call `submitVerification`.",
  extra: [
    "This profile has no `listChangedFiles`, `findFiles`, `getWorkspaceBlame`, `resolveSymbol`, or Context7; the inventory names the paths to inspect.",
  ],
});
