import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server.ts';
import { createTestContext } from './helpers/context.ts';
import type { TestContext } from './helpers/context.ts';

let ctx: TestContext;

afterEach(() => {
  ctx?.cleanup();
});

/** A real MCP client talking to the real server over an in-memory transport. */
async function connect(): Promise<{ client: Client; ctx: TestContext }> {
  ctx = createTestContext();
  const server = createServer(ctx);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, ctx };
}

const EXPECTED_TOOLS = [
  'codex_exec',
  'codex_resume',
  'codex_fork',
  'codex_review',
  'codex_apply',
  'codex_list_sessions',
  'codex_generate_image',
  'codex_job_status',
  'codex_job_logs',
  'codex_job_cancel',
];

describe('tool registration', () => {
  test('exposes exactly the documented tool set', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  });

  test('gives every tool a description an agent can choose from', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 30, `${tool.name} needs a real description`);
    }
  });

  test('declares an input schema for every tool', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} must take an object`);
    }
  });

  test('marks the read-only tools as such', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    assert.equal(byName.get('codex_list_sessions')?.annotations?.readOnlyHint, true);
    assert.equal(byName.get('codex_job_status')?.annotations?.readOnlyHint, true);
    assert.equal(byName.get('codex_exec')?.annotations?.readOnlyHint, false);
  });
});

describe('calling tools', () => {
  test('rejects a call whose arguments fail validation, without spawning anything', async () => {
    const { client, ctx: c } = await connect();
    const result = await client.callTool({ name: 'codex_exec', arguments: {} });

    assert.equal(result.isError, true);
    assert.equal(c.runner.calls.length, 0);
  });

  test('returns both readable text and structured data', async () => {
    const { client, ctx: c } = await connect();
    const call = client.callTool({ name: 'codex_exec', arguments: { prompt: 'say hi' } });

    await c.runner.started();
    c.runner.emit({ type: 'thread.started', thread_id: 'th-7' });
    c.runner.emit({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'hi there' } });
    c.runner.settle();

    const result = (await call) as {
      content: { type: string; text: string }[];
      structuredContent: Record<string, unknown>;
    };

    assert.match(result.content[0]!.text, /hi there/);
    assert.equal(result.structuredContent.thread_id, 'th-7');
    assert.equal(result.structuredContent.mode, 'completed');
  });

  test('turns a guardrail refusal into a tool error the agent can read', async () => {
    const { client, ctx: c } = await connect();
    const result = (await client.callTool({
      name: 'codex_exec',
      arguments: { prompt: 'x', sandbox: 'danger-full-access' },
    })) as { isError: boolean; content: { text: string }[] };

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /CODEX_MCP_ALLOW_DANGEROUS/);
    assert.equal(c.runner.calls.length, 0);
  });

  test('lists sessions without spawning codex', async () => {
    const { client, ctx: c } = await connect();
    const result = (await client.callTool({ name: 'codex_list_sessions', arguments: {} })) as {
      structuredContent: { sessions: unknown[] };
    };

    assert.deepEqual(result.structuredContent.sessions, []);
    assert.equal(c.runner.calls.length, 0);
  });

  test('reports an unknown job as an error rather than an empty result', async () => {
    const { client } = await connect();
    const result = (await client.callTool({
      name: 'codex_job_status',
      arguments: { job_id: 'ghost' },
    })) as { isError: boolean; content: { text: string }[] };

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /ghost/);
  });

  test('round-trips a backgrounded run through the job tools', async () => {
    const { client, ctx: c } = await connect();

    const started = (await client.callTool({
      name: 'codex_exec',
      arguments: { prompt: 'long task', timeout_seconds: 0 },
    })) as { structuredContent: { job_id: string; mode: string } };

    assert.equal(started.structuredContent.mode, 'background');
    const jobId = started.structuredContent.job_id;

    await c.runner.started();
    c.runner.emit({ type: 'turn.started' });

    const logs = (await client.callTool({
      name: 'codex_job_logs',
      arguments: { job_id: jobId },
    })) as { structuredContent: { events: unknown[] } };
    assert.equal(logs.structuredContent.events.length, 1);

    const cancelled = (await client.callTool({
      name: 'codex_job_cancel',
      arguments: { job_id: jobId },
    })) as { structuredContent: { cancelled: boolean } };
    assert.equal(cancelled.structuredContent.cancelled, true);
  });
});
