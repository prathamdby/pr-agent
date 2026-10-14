import { GUEST_CAPABILITY_SPECS } from "../../agent/codemode/guestCatalogue.js";
import { renderCodeModeHarness } from "../shared/tools.js";

export const orchestratorHarness = renderCodeModeHarness({
  guest: GUEST_CAPABILITY_SPECS,
  nativeTools: [
    "execute",
    "resolveLibraryId",
    "getLibraryDocs",
    "submit_specialist_brief",
    "publish_thread",
    "publish_summary",
  ],
  cellBoundary: "Submitting and publishing happen outside the cell, through the active phase tool.",
  extra: [
    "Each phase accepts one terminal tool: recon `submit_specialist_brief`, judgment `publish_thread`, synthesis `publish_summary`. The others return a wrong-phase error. `execute` stays available in every phase.",
    "Confirm `findFiles` and `resolveSymbol` hints with `await tools.readWorkspaceFile` inside `execute` before naming a path or symbol.",
  ],
});
