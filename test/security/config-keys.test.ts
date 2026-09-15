import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assertConfigOverridesAllowed } from '../../src/security/config-keys.ts';
import { ConfigError } from '../../src/config.ts';

const LOCKED = { allowDangerous: false };
const UNLOCKED = { allowDangerous: true };

describe('caller-supplied -c overrides', () => {
  test('lets through the ones that only tune the model', () => {
    assert.doesNotThrow(() =>
      assertConfigOverridesAllowed(['model_reasoning_effort="high"', 'model_verbosity="low"'], LOCKED),
    );
  });

  test('refuses registering an MCP server, which runs outside the sandbox', () => {
    // This is not theoretical: it is exactly how this server attaches its own
    // bridge to a run. Codex spawns the named command as a child, and MCP
    // servers are not sandboxed — so a caller could run anything, under any -s.
    assert.throws(
      () => assertConfigOverridesAllowed(['mcp_servers.pwn.command="cmd.exe"'], LOCKED),
      ConfigError,
    );
  });

  test('refuses the notify hook, which also executes a program', () => {
    assert.throws(() => assertConfigOverridesAllowed(['notify=["cmd.exe"]'], LOCKED), ConfigError);
  });

  test('refuses raising the sandbox behind assertSandboxAllowed', () => {
    for (const pair of [
      'sandbox_mode="danger-full-access"',
      'sandbox_workspace_write.writable_roots=["C:\\\\"]',
      'sandbox_workspace_write.network_access=true',
    ]) {
      assert.throws(() => assertConfigOverridesAllowed([pair], LOCKED), ConfigError, pair);
    }
  });

  test('refuses rewriting the approval policy the bridge depends on', () => {
    for (const pair of ['approval_policy="never"', 'approvals_reviewer="auto_review"']) {
      assert.throws(() => assertConfigOverridesAllowed([pair], LOCKED), ConfigError, pair);
    }
  });

  test('refuses redirecting the model provider, which would exfiltrate the prompt', () => {
    for (const pair of ['model_provider="x"', 'model_providers.x.base_url="https://elsewhere/"']) {
      assert.throws(() => assertConfigOverridesAllowed([pair], LOCKED), ConfigError, pair);
    }
  });

  test('refuses marking a project trusted, which drops approvals', () => {
    assert.throws(() => assertConfigOverridesAllowed(['projects.x.trust_level="trusted"'], LOCKED), ConfigError);
  });

  test('names the key it refused and says how to allow it', () => {
    assert.throws(
      () => assertConfigOverridesAllowed(['mcp_servers.pwn.command="x"'], LOCKED),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /mcp_servers/);
        assert.match(message, /CODEX_MCP_ALLOW_DANGEROUS/);
        return true;
      },
    );
  });

  test('is case-insensitive, so a capitalised key cannot slip past', () => {
    assert.throws(() => assertConfigOverridesAllowed(['Sandbox_Mode="x"'], LOCKED), ConfigError);
  });

  test('ignores surrounding whitespace rather than being fooled by it', () => {
    assert.throws(() => assertConfigOverridesAllowed(['  notify =["x"]'], LOCKED), ConfigError);
  });

  test('refuses a pair with no key at all rather than passing it through', () => {
    assert.throws(() => assertConfigOverridesAllowed(['="value"'], LOCKED), ConfigError);
  });

  test('allows everything on a server started with the dangerous modes unlocked', () => {
    // The operator has already accepted this class of risk explicitly.
    assert.doesNotThrow(() => assertConfigOverridesAllowed(['mcp_servers.x.command="y"'], UNLOCKED));
  });

  test('accepts an empty or absent list', () => {
    assert.doesNotThrow(() => assertConfigOverridesAllowed(undefined, LOCKED));
    assert.doesNotThrow(() => assertConfigOverridesAllowed([], LOCKED));
  });
});
