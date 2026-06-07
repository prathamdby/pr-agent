import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const siteDir = fileURLToPath(new URL(".", import.meta.url));

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
    nitro(),
  ],
});
