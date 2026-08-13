import { setCiStatusQueries } from "../../src/github/ciStatus.js";

/** Default stub so publish/ack paths never hit the live Checks API in unit tests. */
setCiStatusQueries({
  listCheckRunsForHead: async () => [],
  listCheckRunAnnotations: async () => [],
  listLegacyCommitStatusesForHead: async () => [],
});
