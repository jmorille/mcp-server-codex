#!/usr/bin/env node
/**
 * Entry point: an MCP server over stdio.
 *
 * Nothing here may write to stdout — that file descriptor carries the MCP
 * protocol itself, and a stray `console.log` corrupts the stream and breaks the
 * session. Every diagnostic goes to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createRuntime } from './runtime.ts';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.ts';

function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

async function main(): Promise<void> {
  let runtime;
  try {
    runtime = createRuntime(process.env, process.cwd());
  } catch (error) {
    log(`configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  const { context, config } = runtime;

  // Probe the binary but do not refuse to start: a client that can still list
  // the tools and read a clear error is easier to diagnose than one that sees
  // the server die during the handshake.
  const version = await context.runner.version();
  if (version === null) {
    log(
      `WARNING: could not run "${config.binary}". Every tool call will fail. ` +
        'Install the Codex CLI or point CODEX_BIN at it.',
    );
  } else {
    log(`using ${version} (${config.binary})`);
  }

  log(`allowed roots: ${config.allowedRoots.join(', ')}`);
  log(`sandbox: ${config.defaultSandbox}${config.allowDangerous ? ' (dangerous modes UNLOCKED)' : ''}`);

  const server = createServer(context);
  await server.connect(new StdioServerTransport());
  log(`v${SERVER_VERSION} ready on stdio`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, stopping running Codex jobs`);
    runtime.dispose();
    void server.close().finally(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
