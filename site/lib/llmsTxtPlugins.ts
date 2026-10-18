import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { renderLlmsTxt } from "./llmsKnowledge.ts";

const siteDir = fileURLToPath(new URL("..", import.meta.url));

export const LLMS_TXT_MISMATCH = "site/public/llms.txt does not match renderLlmsTxt()";

export type LlmsTxtIo = {
  readonly readFileSync?: typeof readFileSync;
  readonly writeFileSync?: typeof writeFileSync;
  readonly render?: () => string;
};

function committedPath(): string {
  return resolve(siteDir, "public/llms.txt");
}

function watchedModules(): readonly string[] {
  return [
    "llmsKnowledge.ts",
    "agentResources.ts",
    "discovery.ts",
    "content.ts",
    "acceptLanguage.ts",
    "site.ts",
  ].map((name) => resolve(siteDir, "lib", name));
}

export function llmsTxtBuildPlugin(io: LlmsTxtIo = {}): Plugin {
  const read = io.readFileSync ?? readFileSync;
  const render = io.render ?? renderLlmsTxt;
  const path = committedPath();
  return {
    name: "emit-llms-txt-build",
    apply: "build",
    buildStart() {
      const rendered = render();
      const onDisk = read(path, "utf8");
      if (onDisk !== rendered) {
        throw new Error(LLMS_TXT_MISMATCH);
      }
    },
  };
}

export function llmsTxtServePlugin(io: LlmsTxtIo = {}): Plugin {
  const write = io.writeFileSync ?? writeFileSync;
  const render = io.render ?? renderLlmsTxt;
  const path = committedPath();
  const watched = watchedModules();
  const rewrite = () => {
    write(path, render());
  };
  return {
    name: "emit-llms-txt-serve",
    apply: "serve",
    configureServer(server) {
      rewrite();
      server.watcher.add([...watched]);
      server.watcher.on("change", (file) => {
        if (watched.includes(file)) rewrite();
      });
    },
  };
}
