import type { IncomingMessage } from "node:http";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";
import {
  AGENT_INSTRUCTIONS,
  LANDING_PAGE_MARKDOWN,
  LLMS_TXT_PROFILE,
} from "./lib/agentResources.js";
import { contentRevisionBuildPlugin } from "./lib/contentRevisionPlugin.js";
import type { ConditionalHeaders } from "./lib/contentRevision.js";
import { llmsTxtBuildPlugin, llmsTxtServePlugin } from "./lib/llmsTxtPlugins.js";
import {
  agentInstructionsResponse,
  homeMarkdownDocumentResponse,
  llmsProfileResponse,
} from "./lib/siteHttp.js";

const siteDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Serve the markdown routes, and `/llms.txt`, in `vite dev`.
 *
 * Vite's dev middleware claims `.md` requests and tries to resolve them as modules, so
 * `/index.md` and `/agents.md` 404 before the app router sees them. `public/llms.txt` would
 * otherwise be served as a static file whose `Last-Modified` is the request time. The built
 * server handles these paths itself; this only closes the gap locally, using the same responses.
 */
function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) ? value.join(", ") : value;
}

function conditionalFromNode(request: IncomingMessage): ConditionalHeaders {
  return {
    ifNoneMatch: headerValue(request.headers["if-none-match"]),
    ifModifiedSince: headerValue(request.headers["if-modified-since"]),
  };
}

function serveMarkdownRoutesInDev(): Plugin {
  const routes = new Map<string, (request: IncomingMessage) => Response>([
    [
      LANDING_PAGE_MARKDOWN.path,
      (request) =>
        homeMarkdownDocumentResponse(
          headerValue(request.headers["accept-language"]),
          conditionalFromNode(request),
        ),
    ],
    [AGENT_INSTRUCTIONS.path, (request) => agentInstructionsResponse(conditionalFromNode(request))],
    [LLMS_TXT_PROFILE.path, (request) => llmsProfileResponse(conditionalFromNode(request))],
  ]);
  return {
    name: "serve-markdown-routes-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const build = routes.get((request.url ?? "").split("?")[0] ?? "");
        if (build === undefined) {
          next();
          return;
        }
        const built = build(request);
        built
          .text()
          .then((body) => {
            response.statusCode = built.status;
            for (const [name, value] of built.headers) {
              response.setHeader(name, value);
            }
            response.end(body);
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": resolve(siteDir),
    },
  },
  plugins: [
    llmsTxtBuildPlugin(),
    llmsTxtServePlugin(),
    contentRevisionBuildPlugin(),
    serveMarkdownRoutesInDev(),
    tailwindcss(),
    tanstackStart({
      srcDirectory: ".",
      router: {
        routesDirectory: "app",
      },
      // Prerendering wrote `/` to a static file, which Vercel's filesystem handler served before
      // the server function ran. Accept negotiation, `Vary`, and 406 all need the request to
      // reach the function, so `/` renders per request and the CDN caches both variants instead.
      prerender: {
        enabled: false,
      },
    }),
    viteReact(),
    nitro({
      preset: "vercel",
      vercel: {
        entryFormat: "node",
      },
      hooks: {
        // `compiled` belongs to the Vercel preset. It writes `.vercel/output/config.json`.
        // A user hook on that same name replaces it, and Vercel then looks for `dist`.
        // `close` runs after public files are copied and before that preset hook.
        close() {
          // Vercel serves files in `static/` ahead of the function, and stamps Last-Modified
          // with the request time. The route is the response that carries the content date.
          rmSync(resolve(siteDir, ".vercel/output/static/llms.txt"), { force: true });
        },
      },
    }),
  ],
});
