# Agent maintenance rules

## Configuration discoverability

All tunables are catalogued in [docs/configuration.md](docs/configuration.md).

Code entry points:

- **Env-backed defaults** — [src/settings/defaults.ts](src/settings/defaults.ts) and [src/settings/envKeys.ts](src/settings/envKeys.ts); loaded in [src/config.ts](src/config.ts)
- **Code constants** — [src/settings/constants.ts](src/settings/constants.ts), re-exported from [src/settings/index.ts](src/settings/index.ts)

## When you change a knob

| Change | Update |
|--------|--------|
| New or renamed env var | `envKeys.ts`, `defaults.ts`, `config.ts`, `.env.example`, `docs/configuration.md` |
| New or changed code constant | `constants.ts`, `docs/configuration.md` |
| Default value only | `defaults.ts`, `.env.example` (if documented there), `docs/configuration.md` |

Do not add magic numbers or env default strings in feature modules; import from `src/settings/`.

`docs/configuration.md` code-constant rows are maintained on the honor system. CI enforces env alignment via `test/settingsInventory.test.ts`.

## Prompt prose

Long investigator prompt blocks stay in `src/agent/*Prompt*.ts`. Only numeric limits and shared user-visible strings belong in `settings/constants.ts`.
