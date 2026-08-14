import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";
import { renderLlmsTxt } from "./lib/llmsKnowledge";

const siteDir = fileURLToPath(new URL(".", import.meta.url));

function emitLlmsTxt(): Plugin {
  const write = () => {
    writeFileSync(resolve(siteDir, "public/llms.txt"), renderLlmsTxt());
  };
  const watched = [
    resolve(siteDir, "lib/llmsKnowledge.ts"),
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
    tailwindcss(),
    tanstackStart({
      srcDirectory: ".",
      router: {
        routesDirectory: "app",
      },
      prerender: {
        enabled: true,
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
