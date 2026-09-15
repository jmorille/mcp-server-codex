import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { loadConfig, assertSandboxAllowed, assertBypassAllowed, ConfigError } from '../src/config.ts';

const cwd = process.cwd();
const load = (env: Record<string, string | undefined> = {}) => loadConfig(env, cwd);

describe('defaults', () => {
  test('falls back to the codex binary on PATH', () => {
    assert.equal(load().binary, 'codex');
  });

  test('defaults CODEX_HOME to ~/.codex', () => {
    assert.equal(load().codexHome, path.join(os.homedir(), '.codex'));
  });

  test('restricts the allowlist to the working directory', () => {
    assert.deepEqual(load().allowedRoots, [cwd]);
  });

  test('keeps dangerous modes locked', () => {
    assert.equal(load().allowDangerous, false);
  });

  test('defaults the sandbox to workspace-write and the timeout to two minutes', () => {
    const config = load();
    assert.equal(config.defaultSandbox, 'workspace-write');
    assert.equal(config.defaultTimeoutMs, 120_000);
  });
});

describe('overrides', () => {
  test('takes the binary from CODEX_BIN', () => {
    assert.equal(load({ CODEX_BIN: 'C:\\tools\\codex.exe' }).binary, 'C:\\tools\\codex.exe');
  });

  test('takes the codex home from CODEX_HOME', () => {
    assert.equal(load({ CODEX_HOME: '/custom/home' }).codexHome, '/custom/home');
  });

  test('splits CODEX_MCP_ALLOWED_ROOTS on the platform path delimiter', () => {
    const roots = [path.resolve('/a'), path.resolve('/b')];
    const config = load({ CODEX_MCP_ALLOWED_ROOTS: roots.join(path.delimiter) });
    assert.deepEqual(config.allowedRoots, roots);
  });

  test('ignores blank entries in the allowlist', () => {
    const config = load({
      CODEX_MCP_ALLOWED_ROOTS: `${path.resolve('/a')}${path.delimiter}${path.delimiter}  `,
    });
    assert.deepEqual(config.allowedRoots, [path.resolve('/a')]);
  });

  test('replaces rather than extends the default root', () => {
    const config = load({ CODEX_MCP_ALLOWED_ROOTS: path.resolve('/a') });
    assert.ok(!config.allowedRoots.includes(cwd), 'an explicit allowlist must be exhaustive');
  });

  test('rejects a relative root instead of silently resolving it', () => {
    assert.throws(() => load({ CODEX_MCP_ALLOWED_ROOTS: './somewhere' }), ConfigError);
  });

  test('unlocks dangerous modes with 1 or true', () => {
    assert.equal(load({ CODEX_MCP_ALLOW_DANGEROUS: '1' }).allowDangerous, true);
    assert.equal(load({ CODEX_MCP_ALLOW_DANGEROUS: 'true' }).allowDangerous, true);
    assert.equal(load({ CODEX_MCP_ALLOW_DANGEROUS: 'TRUE' }).allowDangerous, true);
    assert.equal(load({ CODEX_MCP_ALLOW_DANGEROUS: '0' }).allowDangerous, false);
    assert.equal(load({ CODEX_MCP_ALLOW_DANGEROUS: 'yes please' }).allowDangerous, false);
  });

  test('reads the default timeout in seconds', () => {
    assert.equal(load({ CODEX_MCP_DEFAULT_TIMEOUT_SECONDS: '30' }).defaultTimeoutMs, 30_000);
  });

  test('rejects a non-numeric timeout rather than silently using a default', () => {
    assert.throws(() => load({ CODEX_MCP_DEFAULT_TIMEOUT_SECONDS: 'soon' }), ConfigError);
  });

  test('rejects a negative timeout', () => {
    assert.throws(() => load({ CODEX_MCP_DEFAULT_TIMEOUT_SECONDS: '-5' }), ConfigError);
  });

  test('accepts a zero timeout, meaning always run in the background', () => {
    assert.equal(load({ CODEX_MCP_DEFAULT_TIMEOUT_SECONDS: '0' }).defaultTimeoutMs, 0);
  });

  test('rejects an unknown default sandbox', () => {
    assert.throws(() => load({ CODEX_MCP_DEFAULT_SANDBOX: 'yolo' }), ConfigError);
  });

  test('accepts each valid sandbox mode', () => {
    assert.equal(load({ CODEX_MCP_DEFAULT_SANDBOX: 'read-only' }).defaultSandbox, 'read-only');
  });
});

describe('dangerous-mode gate', () => {
  test('blocks danger-full-access by default and names the escape hatch', () => {
    assert.throws(
      () => assertSandboxAllowed('danger-full-access', load()),
      /CODEX_MCP_ALLOW_DANGEROUS/,
    );
  });

  test('allows danger-full-access once unlocked', () => {
    assert.doesNotThrow(() =>
      assertSandboxAllowed('danger-full-access', load({ CODEX_MCP_ALLOW_DANGEROUS: '1' })),
    );
  });

  test('never blocks the safe modes', () => {
    assert.doesNotThrow(() => assertSandboxAllowed('read-only', load()));
    assert.doesNotThrow(() => assertSandboxAllowed('workspace-write', load()));
  });

  test('blocks the approvals bypass by default', () => {
    assert.throws(() => assertBypassAllowed(true, load()), ConfigError);
    assert.doesNotThrow(() => assertBypassAllowed(false, load()));
    assert.doesNotThrow(() => assertBypassAllowed(true, load({ CODEX_MCP_ALLOW_DANGEROUS: '1' })));
  });
});
