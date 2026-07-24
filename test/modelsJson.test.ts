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

  it("resolveModelsJsonPath prefers MODELS_JSON_PATH when the file exists", () => {
    const dir = tempDir();
    const explicit = join(dir, "custom-catalog.json");
    writeFileSync(explicit, JSON.stringify({ providers: {} }));
    expect(
      resolveModelsJsonPath({
        cwd: tempDir(),
        explicitPath: explicit,
      }),
    ).toBe(explicit);
  });

  it("resolveModelsJsonPath throws when MODELS_JSON_PATH is set but missing", () => {
    const missing = join(tempDir(), "missing-models.json");
    expect(() =>
      resolveModelsJsonPath({
        cwd: tempDir(),
        explicitPath: missing,
      }),
    ).toThrow(/MODELS_JSON_PATH/);
  });

  it("assertBuiltinPiProvider rejects unknown slugs", () => {
    expect(() => assertBuiltinPiProvider("not-a-real-provider")).toThrow(/unknown/);
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

  it("assertPiModelSelection mentions missing catalog when custom provider has no models.json", async () => {
    await expect(
      assertPiModelSelection({
        modelsJsonPath: null,
        piProvider: "agent-router",
        piModel: "claude-opus-4-6",
        catalogCandidatePath: "/app/models.json",
      }),
    ).rejects.toThrow(/no models\.json catalog was loaded.*\/app\/models\.json.*MODELS_JSON_PATH/s);
  });

  it("assertPiModelSelection accepts anthropic-messages custom provider from models.json", async () => {
    const dir = tempDir();
    const path = join(dir, "models.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          "agent-router": {
            baseUrl: "https://agentrouter.org",
            api: "anthropic-messages",
            apiKey: "test-key",
            models: [
              { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
              { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
            ],
          },
        },
      }),
    );
    await expect(
      assertPiModelSelection({
        modelsJsonPath: path,
        piProvider: "agent-router",
        piModel: "claude-opus-4-6",
      }),
    ).resolves.toBe("anthropic-messages");
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
      PI_PROVIDER: "ollama",
      PI_MODEL: "llama3.1:8b",
    });
    expect(cfg.modelsJsonPath).toBe(join(dir, "models.json"));
    expect(cfg.piProvider).toBe("ollama");
    expect(cfg.piModel).toBe("llama3.1:8b");
    expect(cfg.piApi).toBe("openai-completions");
  });

  it("loads custom provider via MODELS_JSON_PATH outside cwd", async () => {
    const cwd = tempDir();
    const catalogDir = tempDir();
    const catalogPath = join(catalogDir, "providers.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        providers: {
          "agent-router": {
            baseUrl: "https://agentrouter.org",
            api: "anthropic-messages",
            apiKey: "test-key",
            models: [{ id: "claude-opus-4-6", name: "Claude Opus 4.6" }],
          },
        },
      }),
    );
    const cfg = await loadWithCwd(cwd, {
      PI_PROVIDER: "agent-router",
      PI_MODEL: "claude-opus-4-6",
      MODELS_JSON_PATH: catalogPath,
    });
    expect(cfg.modelsJsonPath).toBe(catalogPath);
    expect(cfg.piProvider).toBe("agent-router");
    expect(cfg.piApi).toBe("anthropic-messages");
  });

  it("rejects unknown custom PI_PROVIDER with a missing-catalog hint", async () => {
    const dir = tempDir();
    await expect(
      loadWithCwd(dir, {
        PI_PROVIDER: "agent-router",
        PI_MODEL: "claude-opus-4-6",
      }),
    ).rejects.toThrow(/no models\.json catalog was loaded/);
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
        PI_PROVIDER: "ollama",
        PI_MODEL: "missing-model",
      }),
    ).rejects.toThrow(/not found/);
  });
});
