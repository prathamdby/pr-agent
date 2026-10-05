# ADR 0045: Type narrowing discipline

## Status

Approved for one pull request with scoped commits. Extends
[ADR 0038](0038-fail-on-growth-static-baseline.md) and
[ADR 0039](0039-single-blessed-assertion-escape.md).

## Decision

Narrow values from runtime evidence rather than asserting a desired type.
Keep inferred types and accept only the domain variants an operation supports.
Use control-flow checks and existing guards first. Assertion functions belong
at existing check-and-throw boundaries; they do not replace input validation.
Literal membership tables use own-property checks so inherited keys cannot pass.

The backend denies unsafe narrowing assertions, explicit `any`, and non-null
assertions. Machine diagnostics, not a source regex, define the worklist.
The guard ledger and static baseline force each counted lint rule on explicitly,
even if normal lint configuration turns it off.

For generic results, prefer honest optional returns, typed ownership, or a
decoder at the durable boundary. Do not widen tool callbacks to `unknown`
while leaving their input validation outside the owning closure. Preserve
mutation identities, stored bytes, lease ordering, and no-remutation recovery.
Publication returns `unknown` unless its caller supplies a result decoder.
Typed callers validate stashed results, exact recovery results, and completed
void evidence before receiving a typed value. Validators assert the shape
without parsing or replacing the original object. The erased PR-surface boundary
returns `unknown`; its method-selected validator checks the result at the seam.
Malformed evidence fails terminally without permission to repeat the mutation.
The reviewed `escape(reason, value)` remains the single cast escape, with zero
callers. No other file may suppress the unsafe-assertion rule.

## Failure modes recorded before implementation

1. An erased tool schema loses its relationship with its callback input.
2. A literal-table guard admits inherited names or accepts an incomplete shape.
3. A replacement object guard rejects arrays that an error reader used to inspect.
4. A sanitizer changes getter-failure handling, redaction, or object identity.
5. A logger slot loses shared mutable state when its context is copied.
6. A recovered result invents success, remutates an accepted operation, or
   rejects a valid retained result because its decoder disagrees with a writer.
7. Removing an `undefined as T` cast changes reconciliation detail callbacks.
8. A counted rule is not forced on, or a failed measurement is read as zero.
9. Moving casts into predicates, generic helpers, or suppressions merely hides
   the absence of runtime evidence.

## Verification

Use existing owner suites and dedicated-database integration for webhook,
publication, and database paths. Run the backend gate and disposable-stack
verification. Preserve prompt and tool-schema bytes. Probe enforcement on
temporary violations, including syntax a regex would miss. Record counts,
intentional fallback changes, and unavailable checks in the pull request.

## Enforcement inventory

Backend unsafe assertions, explicit `any`, and non-null assertions each count
zero. The escape helper exempts only its cast line; its caller-chosen type
parameter has a separate rule-specific override. No other backend file is exempt.
The escape-call row counts generic calls and imported aliases as well as
unparameterized calls. Its baseline is zero.

The former zero test-assertion count came from a test override that defeated
CLI `--deny`. Measurement removes rule-specific overrides in a temporary trusted
config before forcing each rule on. The 546 existing test assertions are
explicit retained debt, not a pass: normal fixture lint remains exempt, but both
counting gates prohibit growth. This does not authorize new test files or
fixture casts.

Literal-table guards preserve membership behavior for ordinary inputs and
reject inherited keys. Object-shape readers reject arrays where a record is
required. Malformed non-object webhook JSON is rejected at intake. Invalid
Context7 error fields are omitted rather than treated as strings; malformed
PostHog event shapes cannot bypass sanitization. Invalid stored CI facts raise
a validation error rather than being projected as passing CI. CI validation
retains the original valid object and its stored keys.
Publication result-dependent reconciliation requires a decoder. Invalid retained
results now fail closed instead of being returned as an asserted caller type.
