import { createMiddleware } from "@tanstack/react-start";
import { logAccess, newRequestId } from "./log";

export const requestLoggingMiddleware = createMiddleware({ type: "request" }).server(
  async ({ request, next, pathname }) => {
    const started = Date.now();
    const requestId = newRequestId(request.headers.get("x-request-id"));
    const result = await next();
    const response = result.response;
    const outHeaders = new Headers(response.headers);
    outHeaders.set("x-request-id", requestId);
    logAccess({
      level: "info",
      msg: "access",
      method: request.method,
      path: pathname,
      status: response.status,
      duration_ms: Date.now() - started,
      request_id: requestId,
    });
    return {
      ...result,
      response: new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outHeaders,
      }),
    };
  },
);
