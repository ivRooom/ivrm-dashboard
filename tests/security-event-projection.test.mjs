import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectDiscordAuthAuditEvent } from '../apps/web/lib/security-event-projection.ts';

const sample = {
  auditId: 42,
  requestId: 'c072b4d6-547b-48c2-81fb-232147aa3d79',
  action: 'DISCORD_LOGIN_DENIED',
  result: 'denied',
  actorRole: null,
  targetId: '123456789012345678',
  discordUserId: '123456789012345678',
  reason: 'oauth_state_invalid',
  providerError: 'secret-cookie-token',
  consoleRole: null,
  occurredAt: '2026-10-29T00:00:00Z',
};

test('projects a denied login as an observed indicator, not a confirmed compromise', () => {
  const event = projectDiscordAuthAuditEvent(sample);
  assert.equal(event.eventId, 'discord-auth-audit:42');
  assert.equal(event.severity, 'medium');
  assert.equal(event.confidence, 'observed-event-only');
  assert.equal(event.evidence.auditId, 42);
  assert.equal(event.requestId, sample.requestId);
  assert.equal(event.target.kind, 'discord-user');
});

test('does not expose raw identity, metadata, provider error or session tokens', () => {
  const event = projectDiscordAuthAuditEvent(sample);
  const json = JSON.stringify(event);
  for (const sensitive of [sample.targetId, sample.discordUserId, sample.providerError, sample.reason]) {
    assert.equal(json.includes(sensitive), false);
  }
  assert.equal('metadata' in event, false);
});

test('session revocation is a recorded privileged event, not an intrusion verdict', () => {
  const event = projectDiscordAuthAuditEvent({
    ...sample,
    action: 'DISCORD_SESSION_ADMIN_REVOKED',
    result: 'success',
    actorRole: 'administrator',
  });
  assert.equal(event.target.kind, 'discord-session');
  assert.equal(event.severity, 'low');
  assert.equal(event.actor.role, 'administrator');
  assert.equal(event.confidence, 'observed-event-only');
});

test('success and ordinary session revocation remain informational', () => {
  for (const action of ['DISCORD_LOGIN_SUCCEEDED', 'DISCORD_SESSION_REVOKED']) {
    const event = projectDiscordAuthAuditEvent({ ...sample, action, result: 'success' });
    assert.equal(event.severity, 'info');
  }
});
