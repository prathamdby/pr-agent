## Summary

<!-- What changed and why (2–5 bullets). -->

## Validation

- [ ] `nub run check:code`
- [ ] `nub run test`
- [ ] `nub run test:integration` (or inventory skip when no DB)
- [ ] `nub run site:build` (if `site/` touched)

## Same-PR doc updates

Mirror [AGENTS.md](../AGENTS.md) when applicable:

- [ ] Domain vocabulary / product concept → `CONTEXT.md`
- [ ] Env, default, or code constant → `docs/configuration.md`
- [ ] Module layout / entry points / import rules → `docs/development.md`
- [ ] Runtime topology → `README.md` "How It Works"
- [ ] Behaviour / deploy / scripts → `docs/operations.md`
- [ ] Significant architecture decision → new ADR under `docs/adr/`
- [ ] Cursor Cloud setup → `docs/cursor-cloud.md`
- [ ] N/A — none of the above apply
