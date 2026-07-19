import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { streamCursor } from "./streamCursor.js";

let registered = false;

export function registerCursorProvider(): void {
  if (registered) return;
  registerApiProvider({
    api: "cursor-sdk",
    stream: streamCursor,
    streamSimple: streamCursor,
  });
  registered = true;
}

export function isCursorProviderRegistered(): boolean {
  return registered && getApiProvider("cursor-sdk") !== undefined;
}

export function resetCursorProviderRegistrationForTests(): void {
  registered = false;
}
