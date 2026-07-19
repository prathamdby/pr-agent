# Plan: Verification stub ledger (edit-in-place + resolve-on-dismiss)

## Requirements (locked)

1. **Dismissed → resolve** after posting/editing the dismissed reply (changes ADR 0021).
2. **Dismissed reply** keeps evidence + policy suggestion.
3. **Policy suggestion** reads existing `.pr-agent.yml` and suggests an **append** snippet; if absent, proposes a full properly formatted file.
4. **Still-open**: one stub per thread; later runs **edit in place** (not new replies).
5. **Still-open → dismissed**: edit stub into dismissed body, then resolve.
6. **Scope**: verification only (triage unchanged).

## Architecture

Hybrid ledger + HTML marker (Approach 3):

- Marker in stub body: `<!-- pr-agent:verification-stub -->`
- Resource-scoped `publish_records` detail for lens `verification` / step `verification_thread_actions`:

```ts
{
  threads: {
    [rootCommentId: string]: {
      stubCommentId: number;
      lastVerdict: "skipped" | "dismissed" | "fixed" | "already-resolved";
      lastHeadSha?: string;
      terminal?: boolean;
    }
  }
}
```

- Load ledger by `resource_key` (not `work_item_id`). Merge-update per thread on write.
- Marker scan recovery when ledger stub id missing / edit 404.

## Critical risk mitigation (peer-review)

`publishVerification` currently runs **after** `withPrRepositoryView` returns, so `agentCwd` is gone.

**Required:** Inside the repository view (same place as `runVerification`), call `loadRepoPolicy(view.agentCwd, MAX_REPO_POLICY_BYTES)` and pass the `RepoPolicyResult` (or a publish-oriented summary including raw-present vs absent) into `publishVerification`. Never depend on a live checkout at publish time.

## Publish algorithm (per verdict)

| Verdict                      | Action                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `fixed` / `already-resolved` | Silent resolve if unresolved; mark terminal in ledger                                                     |
| `skipped`                    | If file unchanged: no-op. Else create stub once or edit stub body; update ledger (`lastVerdict: skipped`) |
| `dismissed`                  | Resolve stub body to dismissed + grounded policy; resolve thread; mark terminal                           |

Atomic unit: load ledger → GitHub mutate → merge-write ledger for that thread. Capture `createReply` response `id` as `stubCommentId`.

## Policy render

- `absent` / unreadable: full `version: 1` file template with the new `pathInstructions` entry.
- `ok` with existing `pathInstructions`: show only the YAML fragment to **append** under `pathInstructions:` (bullet entry), plus a one-line note to add under the existing key.
- `invalid`: fall back to full-file template and note that the current file failed validation (do not invent merges).

## Docs / vocabulary

- Update CONTEXT.md: verification dismiss resolves the thread; still-open uses one editable stub.
- Update ADR 0021 (amendment or successor ADR): dismiss is terminal via resolve after one reply/edit.
- Update `docs/operations.md` if publish behaviour is documented there.
- Same-PR settings inventory only if new env/constants are introduced.

## Tests

- Cross-work-item: second publish with empty work_item filter still edits existing stub (ledger by resource_key).
- Skipped twice: create once, then `updateReviewComment`.
- Dismissed with existing stub: update then resolve; no second create.
- Dismissed without stub: create then resolve.
- Policy absent → full file; policy present → append fragment.
- Fixed/already-resolved still silent.
- Marker recovery when ledger lacks stubCommentId but thread has marked bot reply.

## Out of scope

Triage publish parity, review fingerprint / re-file hard gates, auto-commit of `.pr-agent.yml`.
