import { beforeEach } from "vitest";
import { setAppendAgentEvents } from "../../src/agentWork/agentEventsRepository.js";

/** Default stub so unit tests never open a real Postgres connection for agent_events. */
setAppendAgentEvents(async () => undefined);

beforeEach(() => {
  setAppendAgentEvents(async () => undefined);
});
