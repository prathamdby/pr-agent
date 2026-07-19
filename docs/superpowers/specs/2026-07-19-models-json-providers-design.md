# Design: Project `models.json` for Pi custom providers

## Status

Accepted for implementation (peer-reviewed).

## Goal

Allow optional project-root `models.json` in Pi’s native format as a provider/model catalog. `PI_PROVIDER` + `PI_MODEL` still select the active model. If the file is absent, keep today’s env + built-in pi-ai path.

## Decisions

| Topic         | Choice                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Path          | `MODELS_JSON_PATH` when set; else `models.json` at `process.cwd()` (Docker: `/app/models.json`) |
| Selection     | Catalog only; env still picks provider/model                                                    |
| Missing file  | Optional; fall back to env + built-ins                                                          |
| Config timing | Resolve + validate in `loadConfig()`; stash `modelsJsonPath` on `Config`                        |
| Cursor runner | Ignore `models.json` for selection validation and session setup                                 |

## Critical risk (peer review) and mitigation

Stashing a path alone is a no-op: the Pi runner prefers `ModelRegistry.inMemory` and resolves models with `getModel()`, which only knows built-ins.

**Mitigation:**

1. When `modelsJsonPath` is set and `AGENT_PROVIDER=pi`, `loadConfig()` validates via a temporary `ModelRegistry.create` + `find(piProvider, piModel)` (and fails on `getError()`).
2. Pi `createSession` uses `ModelRegistry.create(auth, modelsJsonPath)` (never `inMemory` when the path is set) and resolves the model with `find`; throw a clear error if missing.
3. When `modelsJsonPath` is null, keep `inMemory` + `getModel` and built-in `PI_PROVIDER` validation.
4. Widen `Config.piProvider` to `string` so custom slugs type-check.

## Components

- `src/settings/modelsJson.ts` — path resolve + Pi selection validation helpers
- `src/config.ts` — set `modelsJsonPath`, call validator for `AGENT_PROVIDER=pi`
- `src/agent/providers/pi/index.ts` — registry + model resolution branch
- Docs: `docs/configuration.md`, README provider section
- `models.json.example` — Pi-shaped sample using `$ENV` for keys
- Tests: config validation + Pi runner registry wiring

## Error handling

- Missing file → `modelsJsonPath: null`, env path unchanged
- Present but invalid schema / parse error → `loadConfig()` throws with Pi’s error text
- Present but `PI_PROVIDER`/`PI_MODEL` not found in built-ins ∪ file → `loadConfig()` throws
- Cursor agent → do not validate selection against `models.json`

## Docker image inclusion (refined)

Do **not** commit a production catalog or bake API keys into the image by default. Operators still inject the catalog (Dokploy patch, bind mount, or `MODELS_JSON_PATH`).

**Optional build-context copy:** if repo-root `models.json` is present in the Docker build context, the runtime stage copies it to `/app/models.json`. If it is absent, the build succeeds and runtime stays “no catalog” (built-ins only). This lets Dokploy (and similar) create the file after clone and before `docker build` without a manual Dockerfile edit. Compose bind mounts and `MODELS_JSON_PATH` remain valid overrides.

## Out of scope

- Declaring the active model inside `models.json`
- Pi TypeScript extension custom providers
- Committing a real production `models.json` or API keys into the repo
