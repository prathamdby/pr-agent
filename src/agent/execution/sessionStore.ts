import type { JsonObject } from "./json.js";
import { utf8ByteLength } from "./json.js";
import { CODE_MODE_STATE_MAX_BYTES } from "../../settings/index.js";
import { CodeModeHostHalt } from "../codemode/hostHalt.js";

export type ExecutionSessionStore = {
  readonly generation: number;
  readonly revision: number;
  readonly data: JsonObject;
  readonly admissionOpen: boolean;
  closeAdmission: () => void;
  invalidate: () => void;
  reopenAdmission: () => void;
  commit: (expectedGeneration: number, expectedRevision: number, next: JsonObject) => boolean;
};

export function createExecutionSessionStore(initial: JsonObject = {}): ExecutionSessionStore {
  let generation = 1;
  let revision = 0;
  let data: JsonObject = initial;
  let admissionOpen = true;
  return {
    get generation() {
      return generation;
    },
    get revision() {
      return revision;
    },
    get data() {
      return data;
    },
    get admissionOpen() {
      return admissionOpen;
    },
    closeAdmission() {
      admissionOpen = false;
    },
    invalidate() {
      admissionOpen = false;
      generation += 1;
    },
    reopenAdmission() {
      admissionOpen = true;
    },
    commit(expectedGeneration, expectedRevision, next) {
      if (generation !== expectedGeneration) return false;
      if (revision !== expectedRevision) return false;
      if (utf8ByteLength(next) > CODE_MODE_STATE_MAX_BYTES) {
        throw new CodeModeHostHalt(
          "LIMIT_EXCEEDED",
          `Explicit state exceeds ${CODE_MODE_STATE_MAX_BYTES} bytes`,
        );
      }
      data = next;
      revision += 1;
      return true;
    },
  };
}
