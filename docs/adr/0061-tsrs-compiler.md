# ADR 0061: tsrs compiler

## Status

Accepted. `tsrs` replaces the TypeScript 7 compiler in
[ADR 0055](0055-npm-native-node-toolchain.md). The cooling rules in that ADR
and in `.npmrc` stay unchanged.

## Decision

`tsrs` is the only typecheck and the only emit. `typescript` and
`oxlint-tsgolint` are gone. Root `npm run typecheck` runs
`tsrs --noEmit -p tsconfig.json`. Root `npm run build` runs
`tsrs -p tsconfig.build.json`. The site build runs `vite build`, then
`tsrs --noEmit -p tsconfig.json` and `tsrs --noEmit -p tsconfig.node.json`.
`countEscapeCalls` imports `tsrs/unstable/ast` and `tsrs/unstable/sync`.

The pin is `0.14.1-ts7.1.0-dev.20260929` in both manifests. On 2026-10-20
that string was the newest version `npm install` accepted with
`min-release-age=7` and no exclusion.

`.oxlintrc.json` sets `options.typeAware` to false. These diagnostic codes
no longer run. A clean `src` run printed none of them with the flag on or
off. The list is the enabled `type_aware` rules from `oxlint --rules`
joined to `oxlint --print-config`.

- `typescript(await-thenable)`
- `typescript(consistent-return)`
- `typescript(no-array-delete)`
- `typescript(no-base-to-string)`
- `typescript(no-duplicate-type-constituents)`
- `typescript(no-floating-promises)`
- `typescript(no-for-in-array)`
- `typescript(no-implied-eval)`
- `typescript(no-meaningless-void-operator)`
- `typescript(no-misused-spread)`
- `typescript(no-redundant-type-constituents)`
- `typescript(no-unnecessary-boolean-literal-compare)`
- `typescript(no-unnecessary-template-expression)`
- `typescript(no-unnecessary-type-arguments)`
- `typescript(no-unnecessary-type-assertion)`
- `typescript(no-unnecessary-type-conversion)`
- `typescript(no-unnecessary-type-parameters)`
- `typescript(no-unsafe-enum-comparison)`
- `typescript(no-unsafe-type-assertion)`
- `typescript(no-unsafe-unary-minus)`
- `typescript(no-useless-default-assignment)`
- `typescript(require-array-sort-compare)`
- `typescript(restrict-template-expressions)`
- `typescript(unbound-method)`

`typescript/no-explicit-any` and `typescript/no-non-null-assertion` stay.
They are not `type_aware`, and they still report when `typeAware` is false.
