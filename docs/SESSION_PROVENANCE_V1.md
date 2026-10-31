# QQ Session provenance v1 (development contract)

This candidate is based on the existing v1.2 release branch. It is not a change
to the production connector or to DSH core.

The Host `qq` service adds `sessionProvenanceVersion: 1` and synchronous
`classifySession(id) -> { kind: ordinary | qq | unknown, reason }`.
`resolveTrustedSessionScene()` remains the authority for current QQ Scene
identity; classification alone never grants access to a QQ Scene.

The official Desktop 0.2.1-rc.3 controller accepts a fresh, preallocated Session
ID. QQ atomically writes a UUID reservation before awaiting `create()`, verifies
the returned ID, and keeps reservations even if creation/binding fails. A
mismatching Host response disables new ordinary classification persistently.
During pending creation, unconfirmed ordinary classification fails closed.
The controller's `create()` is not a resume API for a started Session; consumers
must resume through the Host rather than recreate it.

A missing entry in the QQ Store is insufficient. Ordinary Sessions require a
real live Host header with a creation time in the current process's observation
interval. Confirmed ID/creation-time pairs are persisted. Restart, gaps in
observation, missing journals, renamed presets and deleted/recreated IDs cannot
silently turn old uncertain Sessions into ordinary ones. Current/retired QQ
bindings and reserved IDs take precedence over ordinary attestations.

When configured but disabled, QQ maintains classification without starting a
transport. An unconfigured disabled connector declares
`sessionCreationDisabled: true`, returns unknown/qq-unconfigured and does not
choose an implicit state path. A consumer can separately attest newly observed
Host Sessions while that trusted creation-disabled contract is active; it must
not treat historical absence as proof.

## Storage and rollback

The journal is `<statePath>.provenance.json`, adjacent to the existing QQ state.
Keep both files in profile/data backups. It contains IDs/timestamps, not model
keys or chat content. Invalid journals fail startup instead of resetting trust.
Restoring an older program is not proof of a continuous provenance history.
On re-enrollment uncertain historical Sessions stay blocked; restore a matching
snapshot or create a fresh Session. Do not hand-edit attestations.

The Memory PR #7 candidate understands this contract and preserves ordinary
attestations against the full trusted Host header. Older QQ releases do not
implement it. Use the two candidate commit IDs together for this experiment;
version `1.2.0` alone does not imply support. No release tag is created.

## Validation

Windows / Node local suite: 303 passed, 0 failed, 4 skipped. The skipped tests
require symlink creation unavailable in this environment. Targeted tests cover
reservation ordering, failure retention, mismatched IDs, ordinary observations,
restart/renaming, historical gaps, deleted IDs, disabled transport and guards.
Official Desktop 0.2.1-rc.3 was used with the real controller/Workspace/Session
services and actual packaged QQ presets, synthetic QQ Core bindings and a
loopback deterministic model. No NapCat or production account was connected.
See Memory PR #7's final report for model, GUI, graph and rollback evidence.
