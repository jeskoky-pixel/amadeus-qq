import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const trace = JSON.parse(fs.readFileSync(new URL('../docs/m0/continuous-trace.redacted.json', import.meta.url), 'utf8'));
test('historical evidence is explicitly distinguished from a new live test', () => {
  assert.equal(trace.kind, 'historical_tool_metadata_only');
  assert.ok(trace.limitations.some(x => x.includes('No new real-platform messages')));
  assert.match(trace.source.snapshotSha256, /^[a-f0-9]{64}$/);
});
test('only approved metadata fields survive redaction', () => {
  const fields = new Set(['ordinal','sourceLine','elapsedMs','phase','tool','sceneAlias','sessionAlias','ok','hasError','hasReadWatermark','waitPurpose','timeoutMs']);
  for (const event of trace.events) {
    assert.ok(Object.keys(event).every(key => fields.has(key)));
    assert.equal(event.sceneAlias, 'scene-A');
    assert.equal(event.sessionAlias, 'session-A');
    assert.ok(['call', 'result'].includes(event.phase));
  }
});
test('source order and relative times are preserved', () => {
  assert.equal(trace.events[0].elapsedMs, 0);
  for (let i = 1; i < trace.events.length; i++) {
    assert.ok(trace.events[i].sourceLine > trace.events[i - 1].sourceLine);
    assert.ok(trace.events[i].elapsedMs >= trace.events[i - 1].elapsedMs);
  }
});
test('one source session contains successful sends on both sides of a wait', () => {
  const results = trace.events.filter(e => e.phase === 'result' && e.ok === true).map(e => e.tool);
  const send = 'mcp__snowluma__qq_send_message';
  const wait = 'mcp__snowluma__qq_wait_for_messages';
  const firstSend = results.indexOf(send);
  const nextWait = results.indexOf(wait, firstSend + 1);
  assert.ok(firstSend >= 0 && nextWait > firstSend && results.indexOf(send, nextWait + 1) > nextWait);
});
