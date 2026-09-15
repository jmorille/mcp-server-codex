/**
 * How the bridge gets attached to a Codex run.
 *
 * Everything here goes on the command line as `-c key=value` overrides, so the
 * bridge is scoped to the single invocation that carries it. No file in
 * `$CODEX_HOME` is touched, and a run started by anything else — including the
 * user's own terminal — is unaffected.
 *
 * Two facts, both established by running the real CLI rather than by reading
 * docs, shape what is emitted:
 *
 * 1. `-c` values are TOML-parsed. A bare Windows path is not valid TOML, so
 *    every value here is a quoted TOML literal with backslashes escaped.
 * 2. An MCP tool call from inside a sandboxed run is gated by the approval
 *    policy. `approvals_reviewer="auto_review"` plus a granular policy that
 *    allows elicitations — and nothing else — lets the bridge be called while
 *    `-s read-only` still refuses writes. Widening the sandbox instead would
 *    have worked too, and would have been wrong.
 */

/** Name the bridge is registered under, and therefore the prefix Codex uses. */
export const BRIDGE_KEY = 'claude_bridge';

/** How the spawned bridge process learns which mailbox to use. */
export const BRIDGE_DIR_ENV = 'CODEX_BRIDGE_DIR';

/** How it learns which run it belongs to, so two runs cannot read each other's mail. */
export const BRIDGE_THREAD_ENV = 'CODEX_BRIDGE_THREAD';

export interface BridgeWiring {
  /** Directory shared with the bridge process. */
  mailboxDir: string;
  /** Executable Codex spawns, e.g. `process.execPath`. */
  command: string;
  /** Arguments for that executable, typically the path to the bridge entry point. */
  args: string[];
  /** Extra environment for the bridge process, on top of the mailbox directory. */
  env?: Record<string, string>;
}

/** A TOML basic string: the only form that survives a Windows path intact. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/**
 * The approval policy that makes a bridge call possible inside a locked-down
 * run: elicitations allowed, every other escalation still refused.
 */
const GRANULAR_POLICY = 'granular={mcp_elicitations=true,rules=false,sandbox_approval=false}';

/**
 * Build the `-c` overrides that attach the bridge to one run.
 *
 * Deliberately says nothing about the sandbox: that stays the caller's
 * decision, and the whole point of the granular policy is that it does not
 * need to be relaxed.
 */
export function bridgeOverrides(wiring: BridgeWiring): string[] {
  const env: Record<string, string> = { [BRIDGE_DIR_ENV]: wiring.mailboxDir, ...wiring.env };

  const pairs: string[] = [
    `mcp_servers.${BRIDGE_KEY}.command=${tomlString(wiring.command)}`,
    `mcp_servers.${BRIDGE_KEY}.args=${tomlArray(wiring.args)}`,
    ...Object.entries(env).map(([key, value]) => `mcp_servers.${BRIDGE_KEY}.env.${key}=${tomlString(value)}`),
    `approvals_reviewer=${tomlString('auto_review')}`,
    `approval_policy={${GRANULAR_POLICY}}`,
  ];

  return pairs.flatMap((pair) => ['-c', pair]);
}
