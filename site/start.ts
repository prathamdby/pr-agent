import { createMiddleware, createStart } from "@tanstack/react-start";
import {
  conditionalHeaders,
  decorateHtmlResponse,
  landingHtmlConditional,
  negotiateHomeRequest,
  notFoundResponse,
  restateAcceptAsHtml,
} from "@/lib/siteHttp";

/**
 * Accept negotiation for document responses.
 *
 * This runs ahead of the router, which is the only place that can see a request for a path no
 * route matches. Fixed-format endpoints keep their own file routes; this handles the two cases
 * where one URL has more than one representation: the landing page and the 404.
 */
const contentNegotiation = createMiddleware({ type: "request" }).server(
  async ({ request, next }) => {
    const { pathname } = new URL(request.url);
    const accept = request.headers.get("Accept");
    // Only `/` renders the landing page, so only `/` has a markdown representation to negotiate.
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
    } catch {
      // An immutable header bag leaves the framework's own check in charge. Nothing else to do.
    }

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
