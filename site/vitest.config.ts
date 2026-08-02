import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const siteDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(siteDir),
    },
  },
  test: {
    // node env avoids jsdom Float16Array gaps on some Node builds; DOM-free unit tests.
    environment: "node",
    pool: "forks",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".output/**", "dist/**"],
  },
});
