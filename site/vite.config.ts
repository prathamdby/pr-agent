import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";
import { AGENT_INSTRUCTIONS, LANDING_PAGE_MARKDOWN } from "./lib/agentResources.js";
import { renderLlmsTxt } from "./lib/llmsKnowledge.js";
import { agentInstructionsResponse, homeMarkdownDocumentResponse } from "./lib/siteHttp.js";

const siteDir = fileURLToPath(new URL(".", import.meta.url));

function emitLlmsTxt(): Plugin {
  const committedPath = resolve(siteDir, "public/llms.txt");
  // The build must not repair a stale commit. CI's parity test and this
  // check both fail when the committed file disagrees with the renderer.
  const assertCommitted = () => {
    const rendered = renderLlmsTxt();
    const onDisk = readFileSync(committedPath, "utf8");
    if (onDisk !== rendered) {
      throw new Error("site/public/llms.txt does not match renderLlmsTxt()");
    }
  };
  const write = () => {
    writeFileSync(committedPath, renderLlmsTxt());
  };
  // Dev still rewrites the file so a local edit of a watched module stays in sync.
  const watched = [
    resolve(siteDir, "lib/llmsKnowledge.ts"),
    resolve(siteDir, "lib/agentResources.ts"),
    resolve(siteDir, "lib/content.ts"),
    resolve(siteDir, "lib/acceptLanguage.ts"),
    resolve(siteDir, "lib/site.ts"),
  ];
  return {
    name: "emit-llms-txt",
    buildStart: assertCommitted,
    configureServer(server) {
      write();
      server.watcher.add(watched);
      server.watcher.on("change", (file) => {
        if (watched.includes(file)) {
          write();
        }
      });
    },
  };
}

/**
 * Serve the markdown routes in `vite dev`.
 *
 * Vite's dev middleware claims `.md` requests and tries to resolve them as modules, so
 * `/index.md` and `/agents.md` 404 before the app router sees them. The built server handles both
 * paths itself; this only closes the gap locally, using the same responses.
 */
function serveMarkdownRoutesInDev(): Plugin {
  const routes = new Map<string, (request: IncomingMessage) => Response>([
    [
      LANDING_PAGE_MARKDOWN.path,
      (request) => {
        const raw = request.headers["accept-language"];
        const header = Array.isArray(raw) ? raw.join(", ") : (raw ?? null);
        return homeMarkdownDocumentResponse(header);
      },
    ],
    [AGENT_INSTRUCTIONS.path, agentInstructionsResponse],
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
    emitLlmsTxt(),
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
    }),
  ],
});
