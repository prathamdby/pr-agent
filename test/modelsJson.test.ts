import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertBuiltinPiProvider,
  assertPiModelSelection,
  resolveModelsJsonPath,
} from "../src/settings/modelsJson.js";
import { TEST_PRIVATE_KEY_PEM } from "./helpers/testKey.js";

const BASE_ENV = {
  GITHUB_APP_ID: "1",
  WEBHOOK_SECRET: "secret",
  DATABASE_URL: "postgres://u:p@localhost/db",
};

describe("modelsJson helpers", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pr-agent-models-json-test-"));
    dirs.push(dir);
    return dir;
  }

  it("resolveModelsJsonPath returns null when the file is absent", () => {
    expect(resolveModelsJsonPath(tempDir())).toBeNull();
  });

  it("resolveModelsJsonPath returns the absolute path when present", () => {
    const dir = tempDir();
    const path = join(dir, "models.json");
    writeFileSync(path, JSON.stringify({ providers: {} }));
    expect(resolveModelsJsonPath(dir)).toBe(path);
  });

  it("assertBuiltinPiProvider rejects unknown slugs", () => {
    expect(() => assertBuiltinPiProvider("not-a-real-provider")).toThrow(/unknown/);
  });

  it("assertBuiltinPiProvider rejects cursor", () => {
    expect(() => assertBuiltinPiProvider("cursor")).toThrow(/AGENT_PROVIDER=cursor/);
  });

  it("assertPiModelSelection accepts a custom provider from models.json", async () => {
    const dir = tempDir();
    const path = join(dir, "models.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      }),
    );
    await expect(
      assertPiModelSelection({
        modelsJsonPath: path,
        piProvider: "ollama",
        piModel: "llama3.1:8b",
      }),
    ).resolves.toBe("openai-completions");
  });

  it("assertPiModelSelection accepts built-in pairs when models.json is present", async () => {
    const dir = tempDir();
    const path = join(dir, "models.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      }),
    );
    await expect(
      assertPiModelSelection({
        modelsJsonPath: path,
        piProvider: "openai",
        piModel: "gpt-4o-mini",
      }),
    ).resolves.toBe("openai-responses");
  });

  it("assertPiModelSelection accepts built-ins when providers is empty", async () => {
    const dir = tempDir();
    const path = join(dir, "models.json");
    writeFileSync(path, JSON.stringify({ providers: {} }));
    await expect(
      assertPiModelSelection({
        modelsJsonPath: path,
        piProvider: "openai",
        piModel: "gpt-4o-mini",
      }),
    ).resolves.toBe("openai-responses");
  });

  it("assertPiModelSelection rejects a missing model in models.json", async () => {
    const dir = tempDir();
    const path = join(dir, "models.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      }),
    );
    await expect(
      assertPiModelSelection({
        modelsJsonPath: path,
        piProvider: "ollama",
        piModel: "missing-model",
      }),
    ).rejects.toThrow(/not found/);
  });

  it("assertPiModelSelection fails on invalid models.json schema", async () => {
    const dir = tempDir();
    const path = join(dir, "models.json");
    writeFileSync(path, JSON.stringify({ providers: "nope" }));
    await expect(
      assertPiModelSelection({
        modelsJsonPath: path,
        piProvider: "openai",
        piModel: "gpt-4o-mini",
      }),
    ).rejects.toThrow(/Invalid models\.json/);
  });
});

describe("loadConfig models.json", () => {
  const saved = { ...process.env };
  const savedCwd = process.cwd;
  const dirs: string[] = [];

  afterEach(() => {
    process.env = { ...saved };
    process.cwd = savedCwd;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pr-agent-models-json-cwd-"));
    dirs.push(dir);
    return dir;
  }

  async function loadWithCwd(cwd: string, extra: Record<string, string> = {}) {
    process.cwd = () => cwd;
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      ...extra,
    } as NodeJS.ProcessEnv;
    const { loadConfig } = await import("../src/config.js");
    return loadConfig();
  }

  it("sets modelsJsonPath null when the project file is missing", async () => {
    const cfg = await loadWithCwd(tempDir(), {
      PI_PROVIDER: "openai",
      PI_MODEL: "gpt-4o-mini",
    });
    expect(cfg.modelsJsonPath).toBeNull();
  });

  it("loads custom provider selection from project models.json", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      }),
    );
    const cfg = await loadWithCwd(dir, {
      AGENT_PROVIDER: "pi",
      PI_PROVIDER: "ollama",
      PI_MODEL: "llama3.1:8b",
    });
    expect(cfg.modelsJsonPath).toBe(join(dir, "models.json"));
    expect(cfg.piProvider).toBe("ollama");
    expect(cfg.piModel).toBe("llama3.1:8b");
    expect(cfg.piApi).toBe("openai-completions");
  });

  it("rejects invalid selection when models.json is present", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      }),
    );
    await expect(
      loadWithCwd(dir, {
        AGENT_PROVIDER: "pi",
        PI_PROVIDER: "ollama",
        PI_MODEL: "missing-model",
      }),
    ).rejects.toThrow(/not found/);
  });

  it("does not require models.json selection when AGENT_PROVIDER=cursor", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      }),
    );
    const cfg = await loadWithCwd(dir, {
      AGENT_PROVIDER: "cursor",
      CURSOR_API_KEY: "cursor_test_key",
      PI_PROVIDER: "openai",
      PI_MODEL: "composer-2.5",
    });
    expect(cfg.modelsJsonPath).toBe(join(dir, "models.json"));
    expect(cfg.agentProvider).toBe("cursor");
    expect(cfg.piModel).toBe("composer-2.5");
  });

  it("still rejects unknown PI_PROVIDER for cursor when models.json exists", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      }),
    );
    await expect(
      loadWithCwd(dir, {
        AGENT_PROVIDER: "cursor",
        CURSOR_API_KEY: "cursor_test_key",
        PI_PROVIDER: "ollama",
        PI_MODEL: "composer-2.5",
      }),
    ).rejects.toThrow(/unknown/);
  });
});
