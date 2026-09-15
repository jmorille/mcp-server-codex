/**
 * Server configuration, read once from the environment.
 *
 * An MCP server hands a remote agent the ability to run code on this machine,
 * so the defaults are the conservative ones and every widening is an explicit,
 * named environment variable. Misconfiguration fails loudly at startup rather
 * than silently falling back — a typo in a timeout should not quietly become a
 * different policy than the operator asked for.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SandboxMode } from './codex/argv.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ServerConfig {
  binary: string;
  codexHome: string;
  allowedRoots: string[];
  allowDangerous: boolean;
  defaultSandbox: SandboxMode;
  /** 0 means "never wait, always return a job id". */
  defaultTimeoutMs: number;
  maxEvents: number;
  jobTtlMs: number;
  /** Mailbox shared with every bridge process this server spawns. */
  bridgeDir: string;
  /** How long a Codex `ask_claude` call blocks before handing back a question id. */
  bridgeTimeoutMs: number;
  /** Executable Codex spawns for the bridge, and the script to hand it. */
  bridgeCommand: string;
  bridgeEntry: string;
  /** Path to the named image presets this instance was specialised with, if any. */
  imagePresetsFile: string | undefined;
}

export type Env = Record<string, string | undefined>;

const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

function readBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function readSeconds(value: string | undefined, name: string, fallbackMs: number): number {
  if (value === undefined || value.trim() === '') return fallbackMs;

  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    throw new ConfigError(`${name} must be a number of seconds, got "${value}".`);
  }
  if (seconds < 0) {
    throw new ConfigError(`${name} must not be negative, got "${value}".`);
  }
  return Math.round(seconds * 1_000);
}

function readPositiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${value}".`);
  }
  return parsed;
}

function readSandbox(value: string | undefined, fallback: SandboxMode): SandboxMode {
  if (value === undefined || value.trim() === '') return fallback;

  const normalized = value.trim() as SandboxMode;
  if (!SANDBOX_MODES.includes(normalized)) {
    throw new ConfigError(
      `CODEX_MCP_DEFAULT_SANDBOX must be one of ${SANDBOX_MODES.join(', ')}, got "${value}".`,
    );
  }
  return normalized;
}

function readRoots(value: string | undefined, cwd: string): string[] {
  if (value === undefined || value.trim() === '') return [cwd];

  const roots = value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (roots.length === 0) return [cwd];

  for (const root of roots) {
    if (!path.isAbsolute(root)) {
      throw new ConfigError(
        `CODEX_MCP_ALLOWED_ROOTS entries must be absolute paths; "${root}" is relative.`,
      );
    }
  }
  return roots;
}

/**
 * The bridge entry point that ships next to this file.
 *
 * `bridge/index.js` after a build; the `.ts` source when running straight from
 * `src/`, which is how the tests and a development checkout run it.
 */
function defaultBridgeEntry(): string {
  const built = fileURLToPath(new URL('./bridge/index.js', import.meta.url));
  if (fs.existsSync(built)) return built;
  return fileURLToPath(new URL('./bridge/index.ts', import.meta.url));
}

export function loadConfig(env: Env, cwd: string): ServerConfig {
  const codexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');

  return {
    binary: env.CODEX_BIN?.trim() || 'codex',
    codexHome,
    // An explicit allowlist is exhaustive: silently keeping the working
    // directory would defeat the point of naming the roots.
    allowedRoots: readRoots(env.CODEX_MCP_ALLOWED_ROOTS, cwd),
    allowDangerous: readBoolean(env.CODEX_MCP_ALLOW_DANGEROUS),
    defaultSandbox: readSandbox(env.CODEX_MCP_DEFAULT_SANDBOX, 'workspace-write'),
    defaultTimeoutMs: readSeconds(env.CODEX_MCP_DEFAULT_TIMEOUT_SECONDS, 'CODEX_MCP_DEFAULT_TIMEOUT_SECONDS', 120_000),
    maxEvents: readPositiveInt(env.CODEX_MCP_MAX_EVENTS, 'CODEX_MCP_MAX_EVENTS', 2_000),
    jobTtlMs: readSeconds(env.CODEX_MCP_JOB_TTL_SECONDS, 'CODEX_MCP_JOB_TTL_SECONDS', 1_800_000),
    // Under CODEX_HOME by default so it is disposable with the rest of the
    // Codex state, and never inside a workspace where it would show up in a
    // diff or be committed by the agent it is talking to.
    bridgeDir: env.CODEX_MCP_BRIDGE_DIR?.trim() || path.join(codexHome, 'mcp-bridge'),
    bridgeTimeoutMs: readSeconds(env.CODEX_MCP_BRIDGE_TIMEOUT_SECONDS, 'CODEX_MCP_BRIDGE_TIMEOUT_SECONDS', 90_000),
    // The same Node that runs this server: whatever launched it is known to
    // work, whereas a bare "node" on PATH may be a different major version.
    bridgeCommand: env.CODEX_MCP_BRIDGE_COMMAND?.trim() || process.execPath,
    bridgeEntry: env.CODEX_MCP_BRIDGE_ENTRY?.trim() || defaultBridgeEntry(),
    // Not loaded here: reading the file belongs to the image layer, and
    // loadConfig stays a pure reading of the environment.
    imagePresetsFile: env.CODEX_MCP_IMAGE_PRESETS?.trim() || undefined,
  };
}

export function assertSandboxAllowed(sandbox: SandboxMode, config: ServerConfig): void {
  if (sandbox === 'danger-full-access' && !config.allowDangerous) {
    throw new ConfigError(
      'sandbox "danger-full-access" removes every guardrail and is disabled on this server. ' +
        'Start it with CODEX_MCP_ALLOW_DANGEROUS=1 to permit it.',
    );
  }
}

export function assertBypassAllowed(requested: boolean, config: ServerConfig): void {
  if (requested && !config.allowDangerous) {
    throw new ConfigError(
      'dangerously_bypass_approvals_and_sandbox is disabled on this server. ' +
        'Start it with CODEX_MCP_ALLOW_DANGEROUS=1 to permit it.',
    );
  }
}
