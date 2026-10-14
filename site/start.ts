import { createMiddleware, createStart } from "@tanstack/react-start";
import {
  conditionalHeaders,
  decorateHtmlResponse,
  landingHtmlConditional,
  negotiateHomeRequest,
  notFoundResponse,
  restateAcceptAsHtml,
} from "@/lib/siteHttp";

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

    const result = await next();
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
