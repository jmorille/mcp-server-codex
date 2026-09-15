import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMailbox } from '../../src/bridge/mailbox.ts';
import type { Mailbox } from '../../src/bridge/mailbox.ts';
import { inboxTool, replyTool, tellTool } from '../../src/tools/bridge.ts';
import { execTool } from '../../src/tools/exec.ts';
import { createTestContext } from '../helpers/context.ts';
import type { TestContext } from '../helpers/context.ts';

let ctx: TestContext;

afterEach(() => {
  ctx?.cleanup();
});

/** The Codex side: in production a separate process, here the other handle. */
function setup(): { ctx: TestContext; codex: Mailbox } {
  ctx = createTestContext();
  return { ctx, codex: openMailbox(ctx.bridge.dir) };
}

describe('codex_inbox', () => {
  test('delivers what Codex asked, unprompted', async () => {
    const { ctx, codex } = setup();
    codex.post({ from: 'codex', kind: 'question', text: 'should I bump the major?', thread: 'job-1' });

    const result = await inboxTool(ctx, {});

    assert.equal(result.count, 1);
    assert.equal(result.messages[0]?.text, 'should I bump the major?');
    assert.equal(result.messages[0]?.kind, 'question');
    assert.equal(result.messages[0]?.job_id, 'job-1');
  });

  test('does not hand back the same message twice', async () => {
    const { ctx, codex } = setup();
    codex.post({ from: 'codex', kind: 'note', text: 'one' });

    const first = await inboxTool(ctx, {});
    const second = await inboxTool(ctx, { since: first.next_cursor });

    assert.deepEqual(second.messages, []);
  });

  test('never echoes back what Claude itself wrote', async () => {
    const { ctx } = setup();
    await tellTool(ctx, { message: 'mine' });

    assert.deepEqual((await inboxTool(ctx, {})).messages, []);
  });

  test('can watch a single run when several are going at once', async () => {
    const { ctx, codex } = setup();
    codex.post({ from: 'codex', kind: 'note', text: 'from one', thread: 'job-1' });
    codex.post({ from: 'codex', kind: 'note', text: 'from two', thread: 'job-2' });

    const result = await inboxTool(ctx, { job_id: 'job-2' });

    assert.deepEqual(result.messages.map((m) => m.text), ['from two']);
  });

  test('is empty and cheap when nothing has happened', async () => {
    const { ctx } = setup();
    const result = await inboxTool(ctx, {});

    assert.deepEqual(result.messages, []);
    assert.equal(result.next_cursor, 0);
  });

  test('marks which messages are still waiting on an answer', async () => {
    // A question Claude has already answered should not keep demanding
    // attention on every poll.
    const { ctx, codex } = setup();
    const asked = codex.post({ from: 'codex', kind: 'question', text: 'q1' });
    codex.post({ from: 'codex', kind: 'question', text: 'q2' });
    await replyTool(ctx, { message_id: asked.id, text: 'yes' });

    const result = await inboxTool(ctx, {});
    const byText = new Map(result.messages.map((m) => [m.text, m]));

    assert.equal(byText.get('q1')?.answered, true);
    assert.equal(byText.get('q2')?.answered, false);
    assert.equal(result.awaiting_answer, 1);
  });
});

describe('codex_reply', () => {
  test('puts the answer where the blocked Codex call will find it', async () => {
    const { ctx, codex } = setup();
    const asked = codex.post({ from: 'codex', kind: 'question', text: 'which one?' });

    const result = await replyTool(ctx, { message_id: asked.id, text: 'the second' });

    assert.equal(result.in_reply_to, asked.id);
    const delivered = codex.read({ audience: 'codex' }).messages;
    assert.equal(delivered[0]?.text, 'the second');
    assert.equal(delivered[0]?.in_reply_to, asked.id);
  });

  test('sends the answer back to the run that asked, not to all of them', async () => {
    const { ctx, codex } = setup();
    const asked = codex.post({ from: 'codex', kind: 'question', text: 'q', thread: 'job-3' });

    await replyTool(ctx, { message_id: asked.id, text: 'a' });

    assert.equal(codex.read({ audience: 'codex' }).messages[0]?.thread, 'job-3');
  });

  test('refuses an id that matches no question rather than posting into the void', async () => {
    const { ctx } = setup();

    await assert.rejects(() => replyTool(ctx, { message_id: 'nope', text: 'a' }), /nope/);
  });
});

describe('codex_tell', () => {
  test('reaches every run when no run is named', async () => {
    const { ctx, codex } = setup();
    await tellTool(ctx, { message: 'stop, the schema changed' });

    // A run that has its own thread must still see an unaddressed message.
    const seen = codex.read({ audience: 'codex', thread: 'job-5' }).messages;
    assert.deepEqual(seen.map((m) => m.text), ['stop, the schema changed']);
  });

  test('can be aimed at one run', async () => {
    const { ctx, codex } = setup();
    await tellTool(ctx, { message: 'only you', job_id: 'job-5' });

    assert.deepEqual(codex.read({ audience: 'codex', thread: 'job-6' }).messages, []);
    assert.deepEqual(
      codex.read({ audience: 'codex', thread: 'job-5' }).messages.map((m) => m.text),
      ['only you'],
    );
  });

  test('returns the id so the sender can follow the thread', async () => {
    const { ctx } = setup();
    const result = await tellTool(ctx, { message: 'x' });

    assert.ok(result.message_id);
    assert.equal(result.delivered, true);
  });
});

describe('the bridge is always on', () => {
  test('every run is spawned with the bridge attached', async () => {
    // Not opt-in: a run started without it has no way to reach Claude, and the
    // agent has no way to discover that it is missing.
    const { ctx } = setup();
    const call = execTool(ctx, { prompt: 'hello' });
    await ctx.runner.started();
    const args = ctx.runner.calls.at(-1)?.args ?? [];
    ctx.runner.settle();
    const outcome = await call;

    const overrides = args.filter((a, i) => args[i - 1] === '-c');
    assert.ok(
      overrides.some((o) => o.startsWith('mcp_servers.claude_bridge.command=')),
      `expected the bridge to be registered, got ${overrides.join(' ')}`,
    );
    assert.ok(
      overrides.some((o) => o.includes(`CODEX_BRIDGE_THREAD="${outcome.jobId}"`)),
      'the bridge must know which run it belongs to',
    );
  });

  test('a message from that run comes back tagged with its job id', async () => {
    const { ctx, codex } = setup();
    const call = execTool(ctx, { prompt: 'hello' });
    await ctx.runner.started();
    ctx.runner.settle();
    const outcome = await call;

    codex.post({ from: 'codex', kind: 'question', text: 'q', thread: outcome.jobId });
    const inbox = await inboxTool(ctx, { job_id: outcome.jobId });

    assert.equal(inbox.messages[0]?.job_id, outcome.jobId);
  });

  test('does not relax the sandbox to make itself work', async () => {
    const { ctx } = setup();
    const call = execTool(ctx, { prompt: 'hello', sandbox: 'read-only' });
    await ctx.runner.started();
    const args = ctx.runner.calls.at(-1)?.args ?? [];
    ctx.runner.settle();
    await call;

    assert.equal(args[args.indexOf('-s') + 1], 'read-only');
    assert.ok(!args.some((a) => a.startsWith('sandbox_mode=')), 'the bridge must not override the sandbox');
  });
});
