import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { execTool } from '../../src/tools/exec.ts';
import { resumeTool, forkTool } from '../../src/tools/sessions.ts';
import { reviewTool } from '../../src/tools/review.ts';
import { applyTool } from '../../src/tools/apply.ts';
import { ConfigError } from '../../src/config.ts';
import { PathViolationError } from '../../src/security/paths.ts';
import { createTestContext, completeWith } from '../helpers/context.ts';
import type { TestContext } from '../helpers/context.ts';

let ctx: TestContext;

afterEach(() => {
  ctx?.cleanup();
});

function fresh(env: Record<string, string> = {}): TestContext {
  ctx = createTestContext(env);
  return ctx;
}

/** argv the stub runner actually received. */
function argv(context: TestContext): string[] {
  return context.runner.calls[0]!.args;
}

describe('codex_exec', () => {
  test('sends the prompt through stdin and marks it with a dash in argv', async () => {
    const c = fresh();
    await completeWith(c.runner, execTool(c, { prompt: 'Refactor the parser' }));

    assert.equal(c.runner.calls[0]!.stdin, 'Refactor the parser');
    assert.equal(argv(c).at(-1), '-');
    assert.ok(!argv(c).includes('Refactor the parser'));
  });

  test('always asks codex for JSONL', async () => {
    const c = fresh();
    await completeWith(c.runner, execTool(c, { prompt: 'x' }));
    assert.ok(argv(c).includes('--json'));
  });

  test('applies the server default sandbox', async () => {
    const c = fresh({ CODEX_MCP_DEFAULT_SANDBOX: 'read-only' });
    await completeWith(c.runner, execTool(c, { prompt: 'x' }));

    const index = argv(c).indexOf('-s');
    assert.equal(argv(c)[index + 1], 'read-only');
  });

  test('lets the call override the sandbox', async () => {
    const c = fresh();
    await completeWith(c.runner, execTool(c, { prompt: 'x', sandbox: 'read-only' }));
    assert.equal(argv(c)[argv(c).indexOf('-s') + 1], 'read-only');
  });

  test('runs in the requested working directory once it passes the allowlist', async () => {
    const c = fresh();
    const sub = path.join(c.workspace, 'pkg');
    fs.mkdirSync(sub);

    await completeWith(c.runner, execTool(c, { prompt: 'x', cwd: sub }));
    assert.equal(c.runner.calls[0]!.cwd, fs.realpathSync(sub));
  });

  test('defaults the working directory to the first allowed root', async () => {
    const c = fresh();
    await completeWith(c.runner, execTool(c, { prompt: 'x' }));
    assert.equal(c.runner.calls[0]!.cwd, c.workspace);
  });

  test('refuses a working directory outside the allowlist', async () => {
    const c = fresh();
    await assert.rejects(() => execTool(c, { prompt: 'x', cwd: 'C:\\Windows' }), PathViolationError);
    assert.equal(c.runner.calls.length, 0, 'nothing may be spawned once the path is refused');
  });

  test('refuses an extra writable directory outside the allowlist', async () => {
    const c = fresh();
    await assert.rejects(
      () => execTool(c, { prompt: 'x', add_dir: ['/etc'] }),
      PathViolationError,
    );
  });

  test('refuses an image attachment outside the allowlist', async () => {
    const c = fresh();
    await assert.rejects(() => execTool(c, { prompt: 'x', images: ['/etc/passwd'] }), PathViolationError);
  });

  test('blocks danger-full-access unless the server was unlocked', async () => {
    const c = fresh();
    await assert.rejects(
      () => execTool(c, { prompt: 'x', sandbox: 'danger-full-access' }),
      ConfigError,
    );
  });

  test('allows danger-full-access on an unlocked server', async () => {
    const c = fresh({ CODEX_MCP_ALLOW_DANGEROUS: '1' });
    await completeWith(c.runner, execTool(c, { prompt: 'x', sandbox: 'danger-full-access' }));
    assert.equal(argv(c)[argv(c).indexOf('-s') + 1], 'danger-full-access');
  });

  test('blocks the approvals bypass unless the server was unlocked', async () => {
    const c = fresh();
    await assert.rejects(
      () => execTool(c, { prompt: 'x', dangerously_bypass_approvals_and_sandbox: true }),
      ConfigError,
    );
  });

  test('returns the thread id so the caller can resume the session', async () => {
    const c = fresh();
    const outcome = await completeWith(c.runner, execTool(c, { prompt: 'x' }), (r) =>
      r.emit({ type: 'thread.started', thread_id: 'th-42' }),
    );
    assert.equal(outcome.threadId, 'th-42');
  });

  test('switches to a background job when the call-level timeout elapses', async () => {
    const c = fresh();
    const outcome = await execTool(c, { prompt: 'x', timeout_seconds: 0 });

    assert.equal(outcome.mode, 'background');
    assert.ok(outcome.jobId);
    c.runner.settle();
  });
});

describe('codex_resume', () => {
  test('resumes a session by id', async () => {
    const c = fresh();
    await completeWith(c.runner, resumeTool(c, { session_id: 'sess-1', prompt: 'carry on' }));

    assert.deepEqual(argv(c).slice(0, 3), ['exec', 'resume', '--json']);
    assert.ok(argv(c).includes('sess-1'));
    assert.equal(c.runner.calls[0]!.stdin, 'carry on');
  });

  test('resumes the latest session', async () => {
    const c = fresh();
    await completeWith(c.runner, resumeTool(c, { last: true, prompt: 'carry on' }));
    assert.ok(argv(c).includes('--last'));
  });

  test('routes the sandbox through -c since resume has no -s', async () => {
    const c = fresh({ CODEX_MCP_DEFAULT_SANDBOX: 'read-only' });
    await completeWith(c.runner, resumeTool(c, { session_id: 's', prompt: 'p' }));

    assert.ok(!argv(c).includes('-s'));
    assert.ok(argv(c).includes('sandbox_mode="read-only"'));
  });

  test('rejects a call that names neither a session nor last', async () => {
    const c = fresh();
    await assert.rejects(() => resumeTool(c, { prompt: 'p' }), /session_id|last/i);
  });
});

describe('codex_fork', () => {
  test('forks a session by id', async () => {
    const c = fresh();
    await completeWith(c.runner, forkTool(c, { session_id: 'sess-9', prompt: 'try another way' }));

    assert.deepEqual(argv(c).slice(0, 3), ['exec', 'fork', '--json']);
    assert.ok(argv(c).includes('sess-9'));
  });
});

describe('codex_review', () => {
  test('goes through exec review, the only review path that speaks JSONL', async () => {
    const c = fresh();
    await completeWith(c.runner, reviewTool(c, { uncommitted: true }));
    assert.deepEqual(argv(c).slice(0, 3), ['exec', 'review', '--json']);
  });

  test('reviews against a base branch', async () => {
    const c = fresh();
    await completeWith(c.runner, reviewTool(c, { base: 'main' }));
    assert.deepEqual(argv(c).slice(-2), ['--base', 'main']);
  });

  test('rejects two review targets at once', async () => {
    const c = fresh();
    await assert.rejects(() => reviewTool(c, { uncommitted: true, commit: 'abc' }), /single review target/i);
  });

  test('defaults to reviewing uncommitted changes when no target is given', async () => {
    const c = fresh();
    await completeWith(c.runner, reviewTool(c, {}));
    assert.ok(argv(c).includes('--uncommitted'));
  });
});

describe('codex_apply', () => {
  test('applies a task diff in the allowed workspace', async () => {
    const c = fresh();
    await completeWith(c.runner, applyTool(c, { task_id: 'task-7' }));

    assert.deepEqual(argv(c), ['apply', 'task-7']);
    assert.equal(c.runner.calls[0]!.cwd, c.workspace);
  });
});
