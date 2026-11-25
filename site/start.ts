import { createMiddleware, createStart } from "@tanstack/react-start";
import {
  conditionalHeaders,
  decorateHtmlResponse,
  landingHtmlConditional,
  negotiateHomeRequest,
  notFoundResponse,
  restateAcceptAsHtml,
} from "@/lib/siteHttp";
import { bindPageOrigin, requestOrigin } from "@/lib/site";

type RequestOriginStorage = {
  getStore(): string | undefined;
  run<Result>(origin: string, next: () => Result): Result;
};

let requestOrigins: Promise<RequestOriginStorage> | undefined;

function requestOriginStorage() {
  requestOrigins ??= import("node:async_hooks").then(({ AsyncLocalStorage }) => {
    const storage = new AsyncLocalStorage<string>();
    bindPageOrigin(storage);
    return storage;
  });
  return requestOrigins;
}

const contentNegotiation = createMiddleware({ type: "request" }).server(
  async ({ request, next }) => {
    const { pathname } = new URL(request.url);
    const accept = request.headers.get("Accept");
    const isHome = pathname === "/";

    if (isHome) {
      const conditional = conditionalHeaders(request);
      const negotiated = negotiateHomeRequest(
        accept,
        request.headers.get("Accept-Language"),
        conditional,
      );
      if (negotiated !== null) {
        return negotiated;
      }
      const fresh = landingHtmlConditional(conditional.ifNoneMatch, conditional.ifModifiedSince);
      if (fresh !== null) {
        return fresh;
      }
    }
    try {
      restateAcceptAsHtml(request.headers);
    } catch {}

    const pageOrigins = await requestOriginStorage();
    const result = await pageOrigins.run(requestOrigin(request), () => next());
    if (result.response.status === 404) {
      return { ...result, response: notFoundResponse(pathname, accept, result.response) };
    }
    if (isHome) {
      return { ...result, response: decorateHtmlResponse(result.response) };
    }
    return result;
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [contentNegotiation],
}));
