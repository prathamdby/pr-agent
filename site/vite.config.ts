import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";
import { AGENT_INSTRUCTIONS, LANDING_PAGE_MARKDOWN } from "./lib/agentResources";
import { renderLlmsTxt } from "./lib/llmsKnowledge";
import { agentInstructionsResponse, homeMarkdownDocumentResponse } from "./lib/siteHttp";

const siteDir = fileURLToPath(new URL(".", import.meta.url));

function emitLlmsTxt(): Plugin {
  const write = () => {
    writeFileSync(resolve(siteDir, "public/llms.txt"), renderLlmsTxt());
  };
  // Every module renderLlmsTxt reads from, so a dev edit to any of them rewrites the committed file.
  const watched = [
    resolve(siteDir, "lib/llmsKnowledge.ts"),
    resolve(siteDir, "lib/agentResources.ts"),
    resolve(siteDir, "lib/content.ts"),
    resolve(siteDir, "lib/site.ts"),
  ];
  return {
    name: "emit-llms-txt",
    buildStart: write,
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
  const routes = new Map([
    [LANDING_PAGE_MARKDOWN.path, homeMarkdownDocumentResponse],
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
        const built = build();
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
