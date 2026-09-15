import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { createServer, SERVER_VERSION } from '../src/server.ts';
import { createTestContext } from './helpers/context.ts';
import type { TestContext } from './helpers/context.ts';

let ctx: TestContext;

afterEach(() => {
  ctx?.cleanup();
});

/** A real MCP client talking to the real server over an in-memory transport. */
async function connect(env: Record<string, string> = {}): Promise<{ client: Client; ctx: TestContext }> {
  ctx = createTestContext(env);
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
  'codex_inbox',
  'codex_reply',
  'codex_tell',
];

describe('server identity', () => {
  test('reports the version from package.json, not a hardcoded one', async () => {
    // A hardcoded constant drifted to 0.1.0 while the package shipped 0.0.3,
    // putting a wrong version on the wire to every client that calls initialize.
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    assert.equal(SERVER_VERSION, manifest.version);
  });
});

describe('server description', () => {
  test('publishes what the server is for, not just its name', async () => {
    // This is what shows up in a client's server listing. A name alone leaves
    // an operator guessing whether installing it is worth the risk.
    const { client } = await connect();
    const info = client.getServerVersion();

    assert.ok(info?.description, 'the server must publish a description');
    assert.ok(
      info.description.length > 120,
      `a one-liner does not say what this is for, got: ${info.description}`,
    );
  });

  test('names Codex, so the description says whose agent this drives', async () => {
    const { client } = await connect();
    const description = client.getServerVersion()?.description ?? '';

    assert.match(description, /Codex/);
  });

  test('tells the calling model when reaching for Codex is the right move', async () => {
    // Instructions are read by the agent on the other end, which has to choose
    // between doing the work itself and delegating it. Listing the tools again
    // would be useless; what it needs is the "when".
    const { client } = await connect();
    const instructions = client.getInstructions() ?? '';

    assert.ok(instructions.length > 300, `instructions too thin to steer a choice: ${instructions}`);
    for (const topic of [/sandbox/i, /thread_id|codex_resume/, /codex_inbox|bridge|pont/i]) {
      assert.match(instructions, topic);
    }
  });
});

describe('instance specialisation', () => {
  test('advertises the presets this instance was configured with', async () => {
    // Specialisation lives in the deployment, so the only way a calling agent
    // can learn a preset exists is for the instance to say so.
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-adv-')));
    fs.writeFileSync(path.join(workspace, 'p.json'), JSON.stringify({ mascot: {}, packshot: {} }));
    const { client } = await connect({
      CODEX_MCP_ALLOWED_ROOTS: workspace,
      CODEX_MCP_IMAGE_PRESETS: path.join(workspace, 'p.json'),
    });

    const tool = (await client.listTools()).tools.find((t) => t.name === 'codex_generate_image');

    assert.match(tool?.description ?? '', /mascot/);
    assert.match(tool?.description ?? '', /packshot/);
  });

  test('says nothing about presets on an instance that has none', async () => {
    // A plain install must not advertise a feature it cannot serve.
    const { client } = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'codex_generate_image');

    assert.doesNotMatch(tool?.description ?? '', /preset/i);
  });
});

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

  test('uses snake_case all the way down, including inside usage and commands', async () => {
    // One response used to mix conventions: snake_case at the top level but
    // camelCase inside the nested objects, which makes an agent guess.
    const { client, ctx: c } = await connect();
    const call = client.callTool({ name: 'codex_exec', arguments: { prompt: 'x' } });

    await c.runner.started();
    c.runner.emit({
      type: 'item.completed',
      item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 0, status: 'completed' },
    });
    c.runner.emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    c.runner.settle();

    const result = (await call) as { structuredContent: Record<string, unknown> };
    const flat = JSON.stringify(result.structuredContent);

    assert.ok(!/[a-z][A-Z]/.test(flat), `no camelCase key may survive: ${flat}`);
    const usage = result.structuredContent.usage as Record<string, unknown>;
    assert.equal(usage.input_tokens, 10);
    const commands = result.structuredContent.commands as Record<string, unknown>[];
    assert.equal(commands[0]!.exit_code, 0);
  });

  test('accepts the thread_id it just handed out as a session id', async () => {
    // codex_exec returns thread_id; resume/fork wanted session_id for the very
    // same value, so chaining the two tools failed on the name alone.
    const { client, ctx: c } = await connect();
    const call = client.callTool({
      name: 'codex_resume',
      arguments: { thread_id: 'th-abc', prompt: 'continue' },
    });

    // A rejected input never reaches the runner, so waiting on it would hang
    // instead of failing. Bound the wait and let the assertion do the talking.
    await Promise.race([c.runner.started(), new Promise((resolve) => setTimeout(resolve, 500))]);
    c.runner.settle();
    const result = (await call) as { isError?: boolean; content: { text: string }[] };

    assert.notEqual(result.isError, true, result.content?.[0]?.text ?? '');
    assert.ok(c.runner.calls[0]!.args.includes('th-abc'));
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
