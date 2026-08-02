import { createStart } from "@tanstack/react-start";
import { requestLoggingMiddleware } from "./lib/requestLogging";

export const startInstance = createStart(() => ({
  requestMiddleware: [requestLoggingMiddleware],
}));
