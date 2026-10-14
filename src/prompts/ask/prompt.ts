import { GUEST_CAPABILITY_SPECS } from "../../agent/codemode/guestCatalogue.js";
import { renderCodeModeHarness } from "../shared/tools.js";

export const askInvestigationHarness = renderCodeModeHarness({
  guest: GUEST_CAPABILITY_SPECS,
  nativeTools: ["execute", "resolveLibraryId", "getLibraryDocs"],
  cellBoundary: "The answer goes in your final plain-text reply, not in a cell.",
  extra: [
    "The workspace is a PR head checkout. No tool reads the PR conversation, issues, or external URLs.",
  ],
});
