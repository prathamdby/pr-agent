import { registerApiProvider } from "@earendil-works/pi-ai";
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
