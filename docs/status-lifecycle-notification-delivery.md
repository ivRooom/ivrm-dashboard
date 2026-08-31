# Status Lifecycle Notification Delivery

Issue #106 introduces a durable logical-event layer for Status Center lifecycle notifications without replacing the existing monitoring `notification_outbox`.

## Scope

This phase emits durable events only for lifecycle transitions that are known at mutation time:

- Incident published
- Incident update published
- Incident resolved
- Maintenance published / scheduled
- Maintenance cancelled
- Announcement published

Maintenance started/completed are intentionally excluded. Their lifecycle is derived from `starts_at` / `ends_at` and requires a later time-driven reconciler.

Slack delivery is also excluded from this phase. The schema accepts `slack` as a provider so a later provider implementation does not require another delivery-table redesign.

## Architecture

```text
Status mutation RPC
  └─ same PostgreSQL transaction
      └─ Status row / append-only update
          └─ lifecycle trigger
              └─ notification_events       logical immutable event
                  ├─ notification_deliveries / Discord
                  └─ notification_deliveries / future Slack

Monitoring / Reliability
  └─ notification_outbox                   existing path, unchanged
      └─ notification-dispatch / Discord
```

`notification_events` and `notification_deliveries` are additive. `notification_outbox` is not renamed, deleted, or migrated.

## Transaction boundary

Status mutations keep their existing idempotency contracts. Event creation is attached to the actual durable state transition with PostgreSQL triggers:

- `status_incident_updates AFTER INSERT`
- `status_maintenance_notices AFTER UPDATE OF publication_state`
- `status_announcements AFTER UPDATE OF publication_state`

These triggers execute in the same transaction as the existing mutation RPC. If logical-event creation fails, the status mutation rolls back as well. A successful idempotent retry that does not perform the underlying insert/state transition cannot create a second event.

This avoids re-defining the large existing status mutation RPCs while keeping the same transaction guarantee.

## Event identity

Events use stable bounded keys and public Status IDs:

- Incident: `INC-*`
- Maintenance: `MNT-*`
- Announcement: `ANN-*`

Internal Status UUIDs are not used as public source identifiers and are not included in provider payloads.

The event record contains only bounded presentation data:

- `event_key`
- `event_type`
- `source_type`
- `source_public_id`
- `title`
- `message`
- Console-relative `detail_href`
- `severity`
- `occurred_at`

Webhook URLs, scheduler tokens, service-role credentials, actor sessions, Discord OAuth tokens, and audit metadata are never stored in the event or delivery tables.

## Fan-out decision

Fan-out happens once, inside the event-creation transaction, to the channel rows that exist at that moment.

For each channel:

- enabled + configured + no global suppression: `pending`
- disabled: `suppressed / channel_disabled`
- unconfigured: `suppressed / channel_unconfigured`
- global suppression active: `suppressed / global_suppression`

A suppressed Status lifecycle delivery is not revived later.

This is deliberate:

1. Event creation and initial delivery decision are atomic.
2. Adding a future Slack channel does not enqueue the entire historical event backlog.
3. Events created while a channel is disabled/unconfigured do not burst after re-enable.
4. Retry and claim state stay independent per `(event_id, channel_id)`.
5. The existing monitoring path can retain its separate active-signal revival semantics.

Lazy fan-out at dispatcher time was rejected because it would make the set of recipients depend on when a dispatcher happens to run and makes historical backfill accidents easier. A separate enqueue RPC was also unnecessary for this phase because the required recipient set is already available inside the status mutation transaction.

## Delivery state machine

`notification_deliveries` has a unique `(event_id, channel_id)` contract and independent state per channel:

- `pending`
- `sending`
- `sent`
- `retry`
- `failed`
- `suppressed`

Claim uses `FOR UPDATE SKIP LOCKED`. A claim older than five minutes is recovered to `retry`. Failed deliveries use the existing exponential-backoff shape and become `failed` after five attempts.

A provider failure updates only that delivery row and the corresponding channel health metadata; it does not alter another provider's successful state.

## Dispatcher compatibility

`notification-dispatch` keeps two explicit paths:

1. Existing `notification_outbox` monitoring deliveries
2. New `notification_deliveries` Status lifecycle deliveries

The queues are claimed independently with different claim tokens. A claim failure on one queue does not stop the other queue from making progress.

For Discord, the existing transport boundary remains:

- dedicated scheduler-token SHA-256 verification
- scheduler-token plaintext only in Vault
- Discord webhook only in Edge Function Secret
- HTTPS + Discord host/path allowlist
- `allowed_mentions.parse=[]`
- outbound timeout
- external-send preflight delivery gate
- no provider response body persisted

The Status payload exposes only public IDs and bounded plain text.

## Channel registry compatibility

`notification_channels` previously enforced a single Discord row (`id=1`). Issue #106 widens that registry without changing the legacy row identity:

- provider types: `discord`, `slack`
- `id=1` must remain `discord`
- channel `id` and `channel_type` become immutable after insertion

Legacy monitoring functions continue to target Discord `id=1`, so Host / Container / Backup / Reliability behavior is preserved while future providers can receive independent Status delivery rows.

## Security boundary

Both new tables use RLS + FORCE RLS with no direct table policy. Direct table privileges are revoked from `anon`, `authenticated`, and `service_role`.

Dispatcher operations are exposed only through bounded `SECURITY DEFINER` RPCs with fixed `search_path`:

- claim
- pre-send delivery gate
- suppress
- complete

The internal event creator and lifecycle trigger helpers are not executable by application roles.

`detail_href` is constrained to a single-slash relative Console path. Arbitrary webhook/provider URLs are not accepted from data rows.

## Rollout

Safe production rollout order:

1. Merge repository changes after CI/review gate.
2. Apply `20260831010000_status_notification_delivery_foundation.sql`.
3. Run transactional DB acceptance with synthetic rows and `ROLLBACK`.
4. Check Supabase Security and Performance Advisors.
5. Deploy the updated `notification-dispatch` Edge Function with its existing custom scheduler-token authentication (`verify_jwt=false`).
6. Keep Production Discord channel state unchanged unless a separate acceptance explicitly authorizes enabling/configuring it.

No Vercel web deployment is required for this phase because no web code is changed.
