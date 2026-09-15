import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/runtime.ts';
import { PathViolationError } from '../src/security/paths.ts';

let disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
});

function runtime(env: Record<string, string> = {}) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-rt-')));
  const created = createRuntime({ CODEX_MCP_ALLOWED_ROOTS: workspace, ...env }, workspace);
  disposers.push(() => {
    created.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return { ...created, workspace };
}

describe('createRuntime', () => {
  test('wires the configuration into the context', () => {
    const { context } = runtime({ CODEX_BIN: 'my-codex', CODEX_MCP_DEFAULT_SANDBOX: 'read-only' });

    assert.equal(context.config.binary, 'my-codex');
    assert.equal(context.config.defaultSandbox, 'read-only');
  });

  test('builds a path policy from the configured roots', () => {
    const { context, workspace } = runtime();

    assert.equal(context.paths.resolve(workspace), workspace);
    assert.throws(() => context.paths.resolve(os.tmpdir()), PathViolationError);
  });

  test('gives the context a usable runner and job store', () => {
    const { context } = runtime();

    assert.equal(typeof context.runner.run, 'function');
    assert.deepEqual(context.jobs.list(), []);
  });

  test('propagates a configuration error instead of starting half-configured', () => {
    assert.throws(() => createRuntime({ CODEX_MCP_DEFAULT_TIMEOUT_SECONDS: 'nope' }, process.cwd()), /TIMEOUT/);
  });

  test('cancels running jobs on dispose so no child process is orphaned', () => {
    const { context, dispose } = runtime();
    let cancelled = false;
    context.jobs.create({ tool: 'codex_exec', cancel: () => (cancelled = true) });

    dispose();
    assert.equal(cancelled, true);
  });

  test('dispose is safe to call twice', () => {
    const { dispose } = runtime();
    dispose();
    assert.doesNotThrow(() => dispose());
  });
});
