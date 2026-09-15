import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { openMailbox } from '../../src/bridge/mailbox.ts';
import type { Mailbox } from '../../src/bridge/mailbox.ts';
import { createBridgeServer } from '../../src/bridge/server.ts';

let dir: string;
/** The Claude side: in production this is the other process, here it is us. */
let claude: Mailbox;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-bridge-'));
  claude = openMailbox(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A real MCP client standing in for Codex, talking to the real bridge server. */
async function connect(options: { defaultTimeoutMs?: number; thread?: string } = {}): Promise<Client> {
  const server = createBridgeServer({
    mailboxDir: dir,
    defaultTimeoutMs: options.defaultTimeoutMs ?? 1_000,
    pollMs: 20,
    thread: options.thread,
  });
  const client = new Client({ name: 'codex-stub', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function structured(result: unknown): Record<string, unknown> {
  const payload = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  assert.ok(payload, 'every bridge tool must answer with structuredContent');
  return payload;
}

describe('bridge tool surface', () => {
  test('exposes exactly the three tools Codex needs', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    assert.deepEqual(tools.map((t) => t.name).sort(), ['ask_claude', 'check_claude', 'tell_claude']);
  });

  test('describes each tool well enough for Codex to pick one', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 30, `${tool.name} needs a real description`);
    }
  });
});

describe('ask_claude', () => {
  test('returns the answer Claude posts while the call is blocked', async () => {
    const client = await connect();

    // Claude is polling in its own process; simulate it answering mid-call.
    const timer = setTimeout(() => {
      const pending = claude.read({ audience: 'claude' }).messages;
      const question = pending.at(-1);
      if (question) claude.post({ from: 'claude', kind: 'answer', text: 'use zod', inReplyTo: question.id });
    }, 80);

    const result = structured(
      await client.callTool({ name: 'ask_claude', arguments: { question: 'which validator?' } }),
    );
    clearTimeout(timer);

    assert.equal(result.answered, true);
    assert.equal(result.answer, 'use zod');
    assert.equal(result.timed_out, false);
    assert.ok(result.question_id);
  });

  test('hands back the question id instead of hanging when Claude is slow', async () => {
    const client = await connect({ defaultTimeoutMs: 100 });

    const result = structured(await client.callTool({ name: 'ask_claude', arguments: { question: 'anyone?' } }));

    assert.equal(result.answered, false);
    assert.equal(result.timed_out, true);
    assert.equal(result.answer, null);
    // Without the id Codex could never collect the answer on a later turn.
    assert.ok(result.question_id, 'a timed-out question must still be collectable later');
  });

  test('posts the question where Claude can read it', async () => {
    const client = await connect({ defaultTimeoutMs: 50 });
    await client.callTool({ name: 'ask_claude', arguments: { question: 'is the API stable?' } });

    assert.deepEqual(
      claude.read({ audience: 'claude' }).messages.map((m) => m.text),
      ['is the API stable?'],
    );
  });

  test('honours a per-call timeout shorter than the server default', async () => {
    const client = await connect({ defaultTimeoutMs: 30_000 });
    const started = Date.now();

    const result = structured(
      await client.callTool({ name: 'ask_claude', arguments: { question: 'q', timeout_seconds: 0.1 } }),
    );

    assert.equal(result.timed_out, true);
    assert.ok(Date.now() - started < 5_000, 'the per-call timeout must win over the server default');
  });

  test('collects an answer left over from an earlier turn', async () => {
    const client = await connect({ defaultTimeoutMs: 50 });
    const first = structured(await client.callTool({ name: 'ask_claude', arguments: { question: 'slow one' } }));
    assert.equal(first.timed_out, true);

    claude.post({ from: 'claude', kind: 'answer', text: 'here at last', inReplyTo: String(first.question_id) });

    const collected = structured(
      await client.callTool({ name: 'check_claude', arguments: { question_id: first.question_id } }),
    );
    assert.equal(collected.answered, true);
    assert.equal(collected.answer, 'here at last');
  });
});

describe('tell_claude', () => {
  test('delivers without waiting for a reply', async () => {
    const client = await connect({ defaultTimeoutMs: 30_000 });
    const started = Date.now();

    const result = structured(await client.callTool({ name: 'tell_claude', arguments: { message: 'build is green' } }));

    assert.ok(result.message_id);
    assert.equal(result.delivered, true);
    assert.ok(Date.now() - started < 1_000, 'a note must never block on an answer');
    assert.deepEqual(
      claude.read({ audience: 'claude' }).messages.map((m) => m.text),
      ['build is green'],
    );
  });
});

describe('check_claude', () => {
  test('surfaces messages Claude sent unprompted', async () => {
    // This is what makes the bridge two-way: Claude can speak first, and Codex
    // picks the message up at its next tool turn.
    claude.post({ from: 'claude', kind: 'note', text: 'stop, the schema changed' });
    const client = await connect();

    const result = structured(await client.callTool({ name: 'check_claude', arguments: {} }));
    const messages = result.messages as { text: string }[];

    assert.deepEqual(messages.map((m) => m.text), ['stop, the schema changed']);
    assert.equal(result.count, 1);
  });

  test('does not repeat messages already collected', async () => {
    claude.post({ from: 'claude', kind: 'note', text: 'first' });
    const client = await connect();

    const first = structured(await client.callTool({ name: 'check_claude', arguments: {} }));
    const second = structured(await client.callTool({ name: 'check_claude', arguments: { since: first.next_cursor } }));

    assert.deepEqual(second.messages, []);
    assert.equal(second.count, 0);
  });

  test('never echoes back what Codex itself wrote', async () => {
    const client = await connect({ defaultTimeoutMs: 30_000 });
    await client.callTool({ name: 'tell_claude', arguments: { message: 'mine' } });

    const result = structured(await client.callTool({ name: 'check_claude', arguments: {} }));
    assert.deepEqual(result.messages, []);
  });

  test('is empty and harmless when Claude has said nothing', async () => {
    const client = await connect();
    const result = structured(await client.callTool({ name: 'check_claude', arguments: {} }));

    assert.deepEqual(result.messages, []);
    assert.equal(result.next_cursor, 0);
  });
});

describe('run attribution', () => {
  test('stamps every message with the run it came from', () => {
    return (async () => {
      const client = await connect({ defaultTimeoutMs: 30_000, thread: 'job-42' });
      await client.callTool({ name: 'tell_claude', arguments: { message: 'hello' } });

      assert.equal(claude.read({ audience: 'claude' }).messages[0]?.thread, 'job-42');
    })();
  });

  test('only shows this run what Claude addressed to it', async () => {
    // Two runs share one mailbox; a message meant for another run must never
    // be delivered here.
    claude.post({ from: 'claude', kind: 'note', text: 'for another run', thread: 'job-99' });
    claude.post({ from: 'claude', kind: 'note', text: 'for me', thread: 'job-42' });
    const client = await connect({ thread: 'job-42' });

    const result = structured(await client.callTool({ name: 'check_claude', arguments: {} }));
    assert.deepEqual((result.messages as { text: string }[]).map((m) => m.text), ['for me']);
  });
});
