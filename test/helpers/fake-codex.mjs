#!/usr/bin/env node
/**
 * A scriptable stand-in for the Codex CLI.
 *
 * It lets the runner tests exercise the real spawn / stdin / streaming /
 * cancellation path without spending tokens or waiting on a model. Behaviour is
 * driven entirely by environment variables so the argv stays exactly what the
 * builders produced — which is the thing under test.
 *
 *   FAKE_CODEX_FIXTURE     file whose lines are emitted on stdout, one per tick
 *   FAKE_CODEX_ARGV_OUT    write the received argv here as JSON
 *   FAKE_CODEX_STDIN_OUT   write the received stdin here
 *   FAKE_CODEX_CWD_OUT     write the process cwd here
 *   FAKE_CODEX_STDERR      text to emit on stderr
 *   FAKE_CODEX_EXIT        exit code (default 0)
 *   FAKE_CODEX_SLEEP_MS    stay alive this long before exiting
 *   FAKE_CODEX_IGNORE_TERM ignore SIGTERM, to test escalation to SIGKILL
 */

import fs from 'node:fs';

const args = process.argv.slice(2);

if (process.env.FAKE_CODEX_ARGV_OUT) {
  fs.writeFileSync(process.env.FAKE_CODEX_ARGV_OUT, JSON.stringify(args));
}
if (process.env.FAKE_CODEX_CWD_OUT) {
  fs.writeFileSync(process.env.FAKE_CODEX_CWD_OUT, process.cwd());
}
if (process.env.FAKE_CODEX_IGNORE_TERM === '1') {
  process.on('SIGTERM', () => {});
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // `--version` short-circuits: the server probes the binary this way at boot.
  if (args[0] === '--version') {
    process.stdout.write('codex-cli 0.154.0\n');
    return 0;
  }

  const stdin = await readStdin();
  if (process.env.FAKE_CODEX_STDIN_OUT) {
    fs.writeFileSync(process.env.FAKE_CODEX_STDIN_OUT, stdin);
  }

  if (process.env.FAKE_CODEX_FIXTURE) {
    const lines = fs
      .readFileSync(process.env.FAKE_CODEX_FIXTURE, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    for (const line of lines) {
      process.stdout.write(line + '\n');
      // A tick between lines forces the reader to reassemble a real stream
      // rather than one convenient single chunk.
      await sleep(1);
    }
  }

  if (process.env.FAKE_CODEX_STDERR) {
    process.stderr.write(process.env.FAKE_CODEX_STDERR);
  }

  const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS ?? '0');
  if (sleepMs > 0) await sleep(sleepMs);

  return Number(process.env.FAKE_CODEX_EXIT ?? '0');
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(String(error?.stack ?? error));
    process.exitCode = 70;
  },
);
