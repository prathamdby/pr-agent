# Testing

Back: [overview.md](./overview.md)

## Commands

```bash
nub run test -- test/appError.test.ts
nub run test
nub run check:code
```

## Done when

- AppError helpers covered
- No regressions in message/`instanceof` tests
- Grep shows no bare `throw new Error` left in `src/` (or an explicit allowlist
  with reason in the PR)
