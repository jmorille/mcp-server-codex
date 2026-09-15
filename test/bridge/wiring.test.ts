import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { bridgeOverrides, BRIDGE_DIR_ENV } from '../../src/bridge/wiring.ts';

const BASE = {
  mailboxDir: path.join('C:', 'work', 'mbox'),
  command: 'node',
  args: [path.join('C:', 'pkg', 'dist', 'bridge.js')],
};

/** Pull the value of a `-c key=value` pair out of the flat argv. */
function override(argv: string[], key: string): string | undefined {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === '-c' && argv[i + 1]?.startsWith(`${key}=`)) return argv[i + 1]?.slice(key.length + 1);
  }
  return undefined;
}

describe('bridge overrides', () => {
  test('registers the bridge as an MCP server Codex will spawn', () => {
    const argv = bridgeOverrides(BASE);

    assert.equal(override(argv, 'mcp_servers.claude_bridge.command'), '"node"');
    assert.ok(override(argv, 'mcp_servers.claude_bridge.args')?.includes('bridge.js'));
  });

  test('passes the mailbox directory through the environment', () => {
    // The two processes agree on nothing but this path; if it does not reach
    // the child, the bridge silently talks to an empty mailbox.
    const argv = bridgeOverrides(BASE);
    const env = override(argv, `mcp_servers.claude_bridge.env.${BRIDGE_DIR_ENV}`);

    assert.ok(env?.includes('mbox'), `expected the mailbox path, got ${env}`);
  });

  test('emits TOML values, not bare strings Codex would fail to parse', () => {
    // `-c key=value` is TOML-parsed: an unquoted Windows path is invalid TOML
    // and takes the whole run down before the prompt is even read.
    const argv = bridgeOverrides(BASE);
    const command = override(argv, 'mcp_servers.claude_bridge.command');

    assert.ok(command?.startsWith('"') && command.endsWith('"'), `expected a quoted TOML string, got ${command}`);
  });

  test('escapes backslashes so a Windows path survives TOML parsing', () => {
    const argv = bridgeOverrides({ ...BASE, mailboxDir: String.raw`C:\work\mbox` });
    const env = override(argv, `mcp_servers.claude_bridge.env.${BRIDGE_DIR_ENV}`);

    assert.equal(env, String.raw`"C:\\work\\mbox"`);
  });

  test('turns the args array into a TOML array', () => {
    const argv = bridgeOverrides({ ...BASE, args: ['a.js', 'b'] });

    assert.equal(override(argv, 'mcp_servers.claude_bridge.args'), '["a.js", "b"]');
  });

  test('lets the bridge be called without loosening the sandbox', () => {
    // Proven empirically: without the granular policy Codex either blocks the
    // MCP call on an approval nobody can answer, or the run has to be given
    // write access it does not need. This pair is what makes both work.
    const argv = bridgeOverrides(BASE);

    assert.equal(override(argv, 'approvals_reviewer'), '"auto_review"');
    const policy = override(argv, 'approval_policy');
    assert.ok(policy?.includes('mcp_elicitations=true'), `expected elicitations allowed, got ${policy}`);
    assert.ok(policy?.includes('sandbox_approval=false'), `sandbox escalation must stay refused, got ${policy}`);
    assert.ok(policy?.includes('rules=false'), `rule approvals must stay refused, got ${policy}`);
  });

  test('never grants write access of its own accord', () => {
    // The sandbox is the caller's decision. If the bridge wiring silently set
    // one, a read-only run would stop being read-only.
    const argv = bridgeOverrides(BASE);

    assert.ok(!argv.includes('-s'), 'the bridge must not set a sandbox');
    assert.equal(override(argv, 'sandbox_mode'), undefined);
  });

  test('carries extra environment through to the child', () => {
    const argv = bridgeOverrides({ ...BASE, env: { CODEX_BRIDGE_TIMEOUT_SECONDS: '45' } });

    assert.equal(override(argv, 'mcp_servers.claude_bridge.env.CODEX_BRIDGE_TIMEOUT_SECONDS'), '"45"');
  });
});
