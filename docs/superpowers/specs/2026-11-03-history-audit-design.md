# Permanent lighting and climate history

Implements Renato's 2026-11-03 brief. Historical observations belong in the
PWA's Postgres database; Home Assistant remains the only source of current
device state. The history remains useful even when a scene or device is removed.

## Business meaning

History explains when rooms changed and offers modest suggestions based on
repeated behavior. It never invents climate readings, assumes an unknown source
was a person, or presents an old observation as live state. Sparse history means
fewer suggestions, not fabricated confidence.

## Implementation choices

- UTC, microsecond-preserving `(entity_id, at)` keys, full attributes, explicit
  unavailable/unknown states, raw HA brightness, Celsius climate values.
- Daily REST backfill with `significant_changes_only=0` and
  `skip_initial_state`: an initial synthetic midnight state is not an event.
  Historical source remains unknown if HA omits context. Scene context matching
  requires an exact context ID, never timing proximity.
- A database cursor advances only with committed rows. Repeated runs overlap
  and upsert idempotently, without erasing richer websocket observations.
- Scheduled reconciliation plus a server-side websocket worker captures future
  full attributes/context. Lost connections reconnect and record gaps; REST
  repairs everything the recorder still exposes. No browser holds HA secrets.
- Preserve scene taps independently of mutable scene metadata. Recorder scene
  activations and explicit app events retain their provenance.
- Existing rooms remain a closed set. Lamps use overrides then the static map;
  unknown entities remain Unassigned. Climate room mapping uses HA areas or an
  explicit operator mapping, never a guess from a temperature value.
- Deterministic weekday timing, scene frequency and hourly climate ranges use
  sample counts. Anomalies require a fresh HA read. History APIs paginate and
  bound queries; MCP adds three named, audited GET tools.
- A fifth History tab, room filtering, day/week chart and chronological events
  reuse the PWA's warm dark tokens and single scrolling main. Suggestions use
  the existing scene action and partial-result behavior.

## Verification and delivery

Real HA inventory, retention probe, idempotent backfill counts/date ranges;
meaningful normalization/cursor/insight/MCP tests; web typecheck and build; MCP
build and tests; phone/desktop screenshots. Commit on `history-audit`, no push or
deploy. Deploy instructions must explicitly activate the worker/schedule and
ensure database backups. Permanent means no app TTL; it does not undo HA purge,
recorder exclusions, or absent hardware.

## Skills applied

Superpowers workflow/delegation and Persimmon background-job principles:
idempotency, persisted progress, bounded jobs, explicit failures. This existing
Coolify/Postgres.js app uses its scheduler instead of adding Railway or pg-boss.
The frontend follows emil-design-eng accessibility and feedback guidance while
retaining the established PWA design.
