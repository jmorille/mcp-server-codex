import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { jobStatusTool, jobLogsTool, jobCancelTool, UnknownJobError } from '../../src/tools/jobs.ts';
import { createTestContext } from '../helpers/context.ts';
import type { TestContext } from '../helpers/context.ts';

let ctx: TestContext;

afterEach(() => {
  ctx?.cleanup();
});

function withJob() {
  ctx = createTestContext();
  let cancelled = false;
  const job = ctx.jobs.create({ tool: 'codex_exec', cancel: () => (cancelled = true) });
  return { ctx, job, wasCancelled: () => cancelled };
}

describe('codex_job_status', () => {
  test('reports a running job', () => {
    const { ctx: c, job } = withJob();
    const status = jobStatusTool(c, { job_id: job.id });

    assert.equal(status.jobId, job.id);
    assert.equal(status.tool, 'codex_exec');
    assert.equal(status.status, 'running');
    assert.equal(status.exitCode, null);
  });

  test('reports a finished job with its exit code', () => {
    const { ctx: c, job } = withJob();
    job.finish({ exitCode: 0 });

    const status = jobStatusTool(c, { job_id: job.id });
    assert.equal(status.status, 'completed');
    assert.equal(status.exitCode, 0);
    assert.ok(status.endedAt !== null);
  });

  test('counts the events seen so far', () => {
    const { ctx: c, job } = withJob();
    job.recordEvent({ type: 'turn.started' });
    assert.equal(jobStatusTool(c, { job_id: job.id }).eventCount, 1);
  });

  test('names the unknown id rather than returning an empty status', () => {
    const { ctx: c } = withJob();
    assert.throws(() => jobStatusTool(c, { job_id: 'job-does-not-exist' }), UnknownJobError);
    assert.throws(() => jobStatusTool(c, { job_id: 'job-does-not-exist' }), /job-does-not-exist/);
  });
});

describe('codex_job_logs', () => {
  function seeded() {
    const made = withJob();
    made.job.recordEvent({ type: 'thread.started', thread_id: 't' });
    made.job.recordEvent({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'hi' } });
    made.job.recordEvent({ type: 'turn.completed' });
    return made;
  }

  test('returns everything from the start', () => {
    const { ctx: c, job } = seeded();
    const page = jobLogsTool(c, { job_id: job.id });

    assert.equal(page.events.length, 3);
    assert.equal(page.nextCursor, 3);
  });

  test('returns only what is new since a cursor', () => {
    const { ctx: c, job } = seeded();
    const page = jobLogsTool(c, { job_id: job.id, since: 2 });

    assert.deepEqual(
      page.events.map((e) => e.type),
      ['turn.completed'],
    );
  });

  test('filters by event type', () => {
    const { ctx: c, job } = seeded();
    const page = jobLogsTool(c, { job_id: job.id, types: ['item.completed'] });

    assert.equal(page.events.length, 1);
    assert.equal(page.nextCursor, 3, 'the cursor must advance past filtered-out events too');
  });

  test('caps the page size while still advancing the cursor correctly', () => {
    const { ctx: c, job } = seeded();
    const page = jobLogsTool(c, { job_id: job.id, limit: 2 });

    assert.equal(page.events.length, 2);
    assert.equal(page.nextCursor, 2, 'a truncated page must resume where it stopped');
  });

  test('rejects an unknown job', () => {
    const { ctx: c } = seeded();
    assert.throws(() => jobLogsTool(c, { job_id: 'nope' }), UnknownJobError);
  });
});

describe('codex_job_cancel', () => {
  test('cancels a running job and signals the process', () => {
    const { ctx: c, job, wasCancelled } = withJob();
    const result = jobCancelTool(c, { job_id: job.id });

    assert.equal(result.cancelled, true);
    assert.equal(result.status, 'cancelled');
    assert.equal(wasCancelled(), true);
  });

  test('reports honestly that an already finished job was not cancelled', () => {
    const { ctx: c, job, wasCancelled } = withJob();
    job.finish({ exitCode: 0 });

    const result = jobCancelTool(c, { job_id: job.id });
    assert.equal(result.cancelled, false);
    assert.equal(result.status, 'completed');
    assert.equal(wasCancelled(), false);
  });

  test('rejects an unknown job', () => {
    const { ctx: c } = withJob();
    assert.throws(() => jobCancelTool(c, { job_id: 'nope' }), UnknownJobError);
  });
});
