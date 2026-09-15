#!/usr/bin/env node
/**
 * The bridge binary, spawned by Codex — never by a human.
 *
 * `mcp-server-codex` registers this as an MCP server on every run it starts,
 * passing the mailbox directory and the run identity through the environment.
 * Codex then launches it the way it launches any other MCP server.
 *
 * Same rule as the main entry point: stdout carries the MCP protocol, so every
 * diagnostic goes to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createBridgeServer, BRIDGE_SERVER_NAME } from './server.ts';
import { BRIDGE_DIR_ENV, BRIDGE_THREAD_ENV } from './wiring.ts';

const DEFAULT_TIMEOUT_SECONDS = 90;

function log(message: string): void {
  process.stderr.write(`[${BRIDGE_SERVER_NAME}] ${message}\n`);
}

function readTimeoutMs(value: string | undefined): number {
  const seconds = Number(value);
  // A bad value must not be silently treated as "wait forever" or "never wait":
  // both turn a supervised run into an unsupervised one.
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : DEFAULT_TIMEOUT_SECONDS * 1_000;
}

async function main(): Promise<void> {
  const mailboxDir = process.env[BRIDGE_DIR_ENV]?.trim();
  if (!mailboxDir) {
    log(`missing ${BRIDGE_DIR_ENV}. This binary is spawned by mcp-server-codex, not run directly.`);
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  const thread = process.env[BRIDGE_THREAD_ENV]?.trim() || undefined;
  const server = createBridgeServer({
    mailboxDir,
    defaultTimeoutMs: readTimeoutMs(process.env.CODEX_BRIDGE_TIMEOUT_SECONDS),
    thread,
  });

  await server.connect(new StdioServerTransport());
  log(`ready on stdio${thread ? ` for run ${thread}` : ''}`);
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
