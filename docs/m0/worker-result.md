# RESULT: T-004 isolated DSH developer smoke task

## Revision 1

Codex independently ran `node --test validate-envelope.test.mjs` against the
first artifact and rejected it with a JavaScript `SyntaxError` at the
`REQUIRED_STRING_FIELDS` declaration: that array literal was closed by `]);`
instead of `];`. This revision fixes exactly that and keeps the public
contract unchanged.

After the fix the whole file was re-inspected for syntax problems: the
`new Set([...])` literals close `]);` as intended, the corrected array
closes `];`, the timestamp regex and its optional non-capturing group are
balanced, and all template literals (including the nested one building the
type list), arrow functions, `if`/`for` blocks, braces and parentheses were
re-checked. The reported error was the only syntax error found, and no logic
was changed.

Tests have NOT been run by me, not before and not in this revision; Codex
owns test execution. This revision does not claim the validator is
test-verified.

## Implemented files

- `validate-envelope.mjs` — exports a pure, synchronous, dependency-free
  `validateEnvelope(value)` that returns `string[]` of deterministic,
  human-readable errors; `[]` means the envelope is valid.
- `RESULT.md` — this report (files, limitations, not-run check).

No other workspace files were created or modified. `CONTRACT.md`,
`validate-envelope.test.mjs`, and the task/contract JSON/MD files were read
only.

## Behavior (shape only, per CONTRACT.md v0.1 EventEnvelope)

- Input must be a non-null, non-array object; anything else returns a single
  error and is not inspected further.
- `schemaVersion` must be present as an own property whose value is exactly
  the number `1`.
- Required own properties `eventId`, `type`, `personaId`, `sceneId`,
  `occurredAt`, `observedAt`, `sourceRef`, `dataScopeRef` must each be
  nonblank strings (whitespace-only rejected).
- `type` must be one of the four documented event types:
  `qq.message.observed`, `qq.delivery.updated`,
  `qq.scene.activity.changed`, `activity.status.changed`.
- Optional `payloadRef`, `correlationId`, `causationId` must be nonblank
  strings when the property is present. A property present with value
  `undefined` is treated as present and rejected.
- Unknown top-level fields are rejected via an allowlist; errors for them are
  emitted in sorted key order.
- `occurredAt` / `observedAt` must match
  `YYYY-MM-DDTHH:mm:ss[.sss]Z` exactly: real UTC calendar timestamps only.
  Date-only values, offsets (`+08:00`), impossible dates (2026-02-30,
  month 13, April 31), hours > 23, minutes > 59, seconds > 59, and
  fractional seconds other than exactly three digits are rejected.
  Years outside 0001–9999 (including 0000) are rejected, which the task
  explicitly permits.
- The input value is never mutated; only reads and a fresh sorted key array
  are used.
- Error order and text are deterministic: unknown fields (sorted),
  `schemaVersion`, required strings in contract order, `type` membership,
  timestamps, optional references.

## Design limitations

- Shape validation only. This is not authentication, authorization,
  deduplication, message-queue, replay-gap, transport, receipt, or product
  plugin behavior, and passing it proves nothing about those concerns.
- Envelopes are not checked against a source/permission registry;
  `sourceRef` / `dataScopeRef` / `personaId` / `sceneId` are only checked
  for being nonblank strings.
- No time-order relation between `occurredAt` and `observedAt` is enforced
  (the contract does not require one), and no clock-skew, expiry, or
  freshness window is validated.
- Timestamps are validated by strict pattern plus calendar rules without
  `Date`; leap seconds (`:60`) and lowercase `z` are rejected by design.
- Only own enumerable string keys are inspected; symbol keys and
  non-enumerable properties are ignored as out of scope for the demo
  validator.
- A present-but-`undefined` optional reference is rejected per the
  read-only test expectations; it is not silently treated as absent.
- No dependencies, no framework, no general plugin implementation, no
  package installation.

## Not-run check

Tests were deliberately NOT executed by me in the first artifact or in
revision 1: the shell is unavailable in this session, and per the task,
Codex runs and reviews tests independently. The earlier rejection came from
Codex's own independent run and is recorded above; it is not evidence that
the current file passes. Exact check to run by Codex from this working
directory:

```
node --test validate-envelope.test.mjs
```

This file does not claim that the check passed.
