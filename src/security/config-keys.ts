/**
 * What a caller may put in `-c`.
 *
 * `config` was a straight passthrough to Codex's entire configuration surface,
 * which made every other guardrail decorative: the sandbox check, the approvals
 * check and the directory allowlist can all be sidestepped by a well-chosen
 * key. The sharpest one is `mcp_servers.<name>.command` — that is precisely how
 * this server attaches its own bridge to a run, and Codex spawns MCP servers as
 * children that the sandbox does not confine. A caller able to set it can run
 * anything, under any `-s`.
 *
 * So the rule is a denylist of key prefixes rather than a fixed allowlist:
 * Codex adds configuration keys often, and an allowlist would silently break
 * legitimate tuning on every upgrade. The denied set is small, stable, and each
 * entry corresponds to a concrete escalation rather than to caution in general.
 *
 * A server started with `CODEX_MCP_ALLOW_DANGEROUS=1` skips all of this: its
 * operator has already accepted this exact class of risk, and it is the same
 * switch that unlocks `danger-full-access`.
 */

import { ConfigError } from '../config.ts';

/** Key prefixes a caller may not set, each with the escalation it enables. */
const DENIED: readonly { prefix: string; why: string }[] = [
  { prefix: 'mcp_servers', why: 'registers a program Codex spawns outside the sandbox' },
  { prefix: 'notify', why: 'runs an external program on Codex events, outside the sandbox' },
  { prefix: 'sandbox_mode', why: 'is the sandbox level, which the server decides' },
  { prefix: 'sandbox_workspace_write', why: 'widens what the sandbox may write to, or opens the network' },
  { prefix: 'approval_policy', why: 'is the approval policy the bridge depends on' },
  { prefix: 'approvals_reviewer', why: 'is the approval reviewer the bridge depends on' },
  // Both spellings: the singular selects the provider, the plural defines one.
  // Denying only the singular leaves the endpoint itself rewritable.
  { prefix: 'model_provider', why: 'redirects the model endpoint, which would send the prompt elsewhere' },
  { prefix: 'model_providers', why: 'defines a model endpoint, which would send the prompt elsewhere' },
  { prefix: 'projects', why: 'can mark a project trusted, which drops approvals' },
  { prefix: 'shell_environment_policy', why: 'controls what the sandboxed commands inherit' },
  { prefix: 'experimental', why: 'exposes unreviewed behaviour' },
];

/**
 * The key part of a `key=value` pair.
 *
 * Compared lower-cased and trimmed: a key is not made safe by capitalising it
 * or padding it with spaces.
 */
function keyOf(pair: string): string {
  const separator = pair.indexOf('=');
  return (separator === -1 ? pair : pair.slice(0, separator)).trim().toLowerCase();
}

/**
 * A prefix matches the key itself or a dotted child of it, never a key that
 * merely starts with the same letters: `notify` must not also deny `notify_me`.
 */
function matches(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(`${prefix}.`);
}

export function assertConfigOverridesAllowed(
  pairs: readonly string[] | undefined,
  policy: { allowDangerous: boolean },
): void {
  if (policy.allowDangerous || pairs === undefined) return;

  for (const pair of pairs) {
    const key = keyOf(pair);

    if (key === '') {
      throw new ConfigError(
        `Config override "${pair}" has no key. Each entry must be key=value, e.g. 'model_reasoning_effort="high"'.`,
      );
    }

    for (const denied of DENIED) {
      if (matches(key, denied.prefix)) {
        throw new ConfigError(
          `Config override "${key}" is refused: it ${denied.why}, which would bypass the guardrails this ` +
            'server enforces. Start the server with CODEX_MCP_ALLOW_DANGEROUS=1 if you really mean to ' +
            'allow it.',
        );
      }
    }
  }
}
