import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runHybrid } from '../../src/jobs/hybrid.ts';
import { createJobStore } from '../../src/jobs/store.ts';
import { createStubRunner } from '../helpers/stub-runner.ts';

function context() {
  const runner = createStubRunner();
  const jobs = createJobStore();
  return { runner, jobs };
}

describe('runs that finish inside the timeout', () => {
  test('returns the full result inline', async () => {
    const { runner, jobs } = context();
    const promise = runHybrid({ runner, jobs }, { tool: 'codex_exec', args: ['exec'], timeoutMs: 5_000 });

    await runner.started();
    runner.emit({ type: 'thread.started', thread_id: 'th-1' });
    runner.emit({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'done' } });
    runner.settle();

    const outcome = await promise;
    assert.equal(outcome.mode, 'completed');
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.threadId, 'th-1');
    assert.equal(outcome.finalMessage, 'done');
    assert.equal(outcome.exitCode, 0);
  });

  test('records the job as completed', async () => {
    const { runner, jobs } = context();
    const promise = runHybrid({ runner, jobs }, { tool: 'codex_exec', args: ['exec'], timeoutMs: 5_000 });

    await runner.started();
    runner.settle();
    const outcome = await promise;

    assert.equal(jobs.get(outcome.jobId)?.status, 'completed');
  });

  test('marks a non-zero exit as failed and surfaces stderr', async () => {
    const { runner, jobs } = context();
    const promise = runHybrid({ runner, jobs }, { tool: 'codex_exec', args: ['exec'], timeoutMs: 5_000 });

    await runner.started();
    runner.settle({ exitCode: 2, stderr: 'boom' });
    const outcome = await promise;

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.exitCode, 2);
    assert.match(outcome.stderr, /boom/);
  });

  test('passes the prompt and working directory to the runner', async () => {
    const { runner, jobs } = context();
    const promise = runHybrid(
      { runner, jobs },
      { tool: 'codex_exec', args: ['exec', '-'], stdin: 'hello', cwd: '/work', timeoutMs: 5_000 },
    );

    await runner.started();
    runner.settle();
    await promise;

    assert.equal(runner.calls[0]!.stdin, 'hello');
    assert.equal(runner.calls[0]!.cwd, '/work');
  });
});

describe('runs that outlive the timeout', () => {
  test('hands back a job id instead of blocking', async () => {
    const { runner, jobs } = context();
    const promise = runHybrid({ runner, jobs }, { tool: 'codex_exec', args: ['exec'], timeoutMs: 30 });

    await runner.started();
    runner.emit({ type: 'thread.started', thread_id: 'th-2' });

    const outcome = await promise;
    assert.equal(outcome.mode, 'background');
    assert.equal(outcome.status, 'running');
    assert.equal(outcome.threadId, 'th-2', 'whatever was seen so far must still come back');
    assert.equal(jobs.get(outcome.jobId)?.status, 'running');

    runner.settle();
  });

  test('keeps the run alive and finishes the job afterwards', async () => {
    const { runner, jobs } = context();
    const outcome = await runHybrid(
      { runner, jobs },
      { tool: 'codex_exec', args: ['exec'], timeoutMs: 30 },
    );

    runner.emit({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'late' } });
    runner.settle();
    // Let the settling microtasks drain.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const job = jobs.get(outcome.jobId);
    assert.equal(job?.status, 'completed');
    assert.equal(job?.eventsSince(0).events.length, 1);
  });

  test('goes straight to the background when the timeout is zero', async () => {
    const { runner, jobs } = context();
    const outcome = await runHybrid(
      { runner, jobs },
      { tool: 'codex_exec', args: ['exec'], timeoutMs: 0 },
    );

    assert.equal(outcome.mode, 'background');
    assert.equal(runner.calls.length, 1, 'the run must still have been started');
    runner.settle();
  });
});

describe('cancellation', () => {
  test('cancelling the job aborts the underlying run', async () => {
    const { runner, jobs } = context();
    const outcome = await runHybrid(
      { runner, jobs },
      { tool: 'codex_exec', args: ['exec'], timeoutMs: 20 },
    );

    assert.equal(jobs.get(outcome.jobId)?.cancel(), true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(jobs.get(outcome.jobId)?.status, 'cancelled');
  });
});

describe('event capture', () => {
  test('stores every event on the job for later polling', async () => {
    const { runner, jobs } = context();
    const promise = runHybrid({ runner, jobs }, { tool: 'codex_exec', args: ['exec'], timeoutMs: 5_000 });

    await runner.started();
    runner.emit({ type: 'turn.started' });
    runner.emit({ type: 'turn.completed' });
    runner.settle();

    const outcome = await promise;
    assert.equal(jobs.get(outcome.jobId)?.eventsSince(0).events.length, 2);
  });
});
