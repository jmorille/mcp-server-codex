import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createJobStore } from '../../src/jobs/store.ts';

/** A clock the tests drive by hand, so TTL behaviour needs no real waiting. */
function fakeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('job creation', () => {
  test('starts a job in the running state with a unique id', () => {
    const store = createJobStore();
    const a = store.create({ tool: 'codex_exec', cancel: () => {} });
    const b = store.create({ tool: 'codex_exec', cancel: () => {} });

    assert.notEqual(a.id, b.id);
    assert.equal(a.status, 'running');
    assert.equal(a.tool, 'codex_exec');
    assert.equal(a.endedAt, null);
  });

  test('makes a job retrievable by id', () => {
    const store = createJobStore();
    const job = store.create({ tool: 'codex_exec', cancel: () => {} });
    assert.equal(store.get(job.id)?.id, job.id);
  });

  test('returns undefined for an unknown id', () => {
    assert.equal(createJobStore().get('nope'), undefined);
  });

  test('lists the most recently created job first', () => {
    const clock = fakeClock();
    const store = createJobStore({ now: clock.now });
    const first = store.create({ tool: 'a', cancel: () => {} });
    clock.advance(10);
    const second = store.create({ tool: 'b', cancel: () => {} });

    assert.deepEqual(
      store.list().map((j) => j.id),
      [second.id, first.id],
    );
  });
});

describe('event buffering', () => {
  test('keeps events in order and reports them from a cursor', () => {
    const store = createJobStore();
    const job = store.create({ tool: 'codex_exec', cancel: () => {} });

    job.recordEvent({ type: 'turn.started' });
    job.recordEvent({ type: 'item.completed' });
    job.recordEvent({ type: 'turn.completed' });

    assert.equal(job.eventsSince(0).events.length, 3);
    assert.deepEqual(
      job.eventsSince(2).events.map((e) => e.type),
      ['turn.completed'],
    );
    assert.equal(job.eventsSince(0).nextCursor, 3);
  });

  test('caps the buffer and counts what it dropped', () => {
    const store = createJobStore({ maxEvents: 2 });
    const job = store.create({ tool: 'codex_exec', cancel: () => {} });

    job.recordEvent({ type: 'one' });
    job.recordEvent({ type: 'two' });
    job.recordEvent({ type: 'three' });

    assert.equal(job.droppedEvents, 1, 'the oldest event must be evicted, not the newest');
    const page = job.eventsSince(0);
    assert.deepEqual(
      page.events.map((e) => e.type),
      ['two', 'three'],
    );
    assert.equal(page.nextCursor, 3, 'the cursor stays absolute despite eviction');
  });

  test('serves a cursor pointing at an evicted event from the oldest one still held', () => {
    const store = createJobStore({ maxEvents: 2 });
    const job = store.create({ tool: 'codex_exec', cancel: () => {} });
    job.recordEvent({ type: 'one' });
    job.recordEvent({ type: 'two' });
    job.recordEvent({ type: 'three' });

    assert.deepEqual(
      job.eventsSince(0).events.map((e) => e.type),
      ['two', 'three'],
    );
  });
});

describe('completion', () => {
  test('marks a job completed with its exit code', () => {
    const clock = fakeClock();
    const store = createJobStore({ now: clock.now });
    const job = store.create({ tool: 'codex_exec', cancel: () => {} });

    clock.advance(500);
    job.finish({ exitCode: 0 });

    assert.equal(job.status, 'completed');
    assert.equal(job.exitCode, 0);
    assert.equal(job.endedAt, 1_500);
    assert.equal(job.durationMs, 500);
  });

  test('marks a job failed when the exit code is non-zero', () => {
    const store = createJobStore();
    const job = store.create({ tool: 'codex_exec', cancel: () => {} });
    job.finish({ exitCode: 1 });
    assert.equal(job.status, 'failed');
  });

  test('marks a job failed when an error is reported', () => {
    const store = createJobStore();
    const job = store.create({ tool: 'codex_exec', cancel: () => {} });
    job.finish({ exitCode: 0, error: 'codex binary not found' });

    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'codex binary not found');
  });

  test('ignores a second finish so a late exit cannot overwrite a cancellation', () => {
    const store = createJobStore();
    const job = store.create({ tool: 'codex_exec', cancel: () => {} });

    job.cancel();
    job.finish({ exitCode: 1 });

    assert.equal(job.status, 'cancelled');
  });
});

describe('cancellation', () => {
  test('invokes the cancel callback exactly once', () => {
    const store = createJobStore();
    let calls = 0;
    const job = store.create({ tool: 'codex_exec', cancel: () => (calls += 1) });

    assert.equal(job.cancel(), true);
    assert.equal(job.cancel(), false, 'cancelling twice must not re-signal the process');
    assert.equal(calls, 1);
    assert.equal(job.status, 'cancelled');
  });

  test('refuses to cancel a job that already finished', () => {
    const store = createJobStore();
    let calls = 0;
    const job = store.create({ tool: 'codex_exec', cancel: () => (calls += 1) });

    job.finish({ exitCode: 0 });

    assert.equal(job.cancel(), false);
    assert.equal(calls, 0);
    assert.equal(job.status, 'completed');
  });

  test('cancelAll only touches running jobs and reports how many it stopped', () => {
    const store = createJobStore();
    const running = store.create({ tool: 'a', cancel: () => {} });
    const done = store.create({ tool: 'b', cancel: () => {} });
    done.finish({ exitCode: 0 });

    assert.equal(store.cancelAll(), 1);
    assert.equal(running.status, 'cancelled');
    assert.equal(done.status, 'completed');
  });
});

describe('reaping', () => {
  test('drops finished jobs past the ttl but keeps running ones forever', () => {
    const clock = fakeClock();
    const store = createJobStore({ now: clock.now, ttlMs: 1_000 });

    const finished = store.create({ tool: 'a', cancel: () => {} });
    const running = store.create({ tool: 'b', cancel: () => {} });
    finished.finish({ exitCode: 0 });

    clock.advance(1_001);
    assert.equal(store.sweep(), 1);
    assert.equal(store.get(finished.id), undefined);
    assert.equal(store.get(running.id)?.id, running.id);
  });

  test('keeps a finished job that is still within the ttl', () => {
    const clock = fakeClock();
    const store = createJobStore({ now: clock.now, ttlMs: 1_000 });
    const job = store.create({ tool: 'a', cancel: () => {} });
    job.finish({ exitCode: 0 });

    clock.advance(999);
    assert.equal(store.sweep(), 0);
    assert.equal(store.get(job.id)?.id, job.id);
  });
});
