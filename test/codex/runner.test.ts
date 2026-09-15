import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCodexRunner } from '../../src/codex/runner.ts';
import type { CodexEvent } from '../../src/codex/events.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCodex = path.join(here, '..', 'helpers', 'fake-codex.mjs');
const fixture = path.join(here, '..', 'fixtures', 'imagegen-run.jsonl');

let scratch: string;

/** The runner under test, wired to the fake CLI instead of the real one. */
function runner(env: Record<string, string> = {}) {
  return createCodexRunner({
    binary: process.execPath,
    argsPrefix: [fakeCodex],
    env: { FAKE_CODEX_FIXTURE: fixture, ...env },
  });
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-runner-'));
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('running codex', () => {
  test('parses the JSONL stream into a summary', async () => {
    const result = await runner().run({ args: ['exec', '--json', '-'] });

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.threadId, '01a0a609-147e-7632-821d-60988a5783f3');
    assert.equal(result.summary.commands.length, 2);
    assert.equal(result.summary.usage?.outputTokens, 682);
  });

  test('passes argv through untouched, after the prefix', async () => {
    const argvOut = path.join(scratch, 'argv.json');
    await runner({ FAKE_CODEX_ARGV_OUT: argvOut }).run({ args: ['exec', '--json', '-s', 'read-only', '-'] });

    assert.deepEqual(JSON.parse(fs.readFileSync(argvOut, 'utf8')), [
      'exec',
      '--json',
      '-s',
      'read-only',
      '-',
    ]);
  });

  test('feeds the prompt through stdin', async () => {
    const stdinOut = path.join(scratch, 'stdin.txt');
    const prompt = 'Explain the retry policy.\nSecond line.';
    await runner({ FAKE_CODEX_STDIN_OUT: stdinOut }).run({ args: ['exec', '-'], stdin: prompt });

    assert.equal(fs.readFileSync(stdinOut, 'utf8'), prompt);
  });

  test('closes stdin even when no prompt is supplied, so codex cannot hang waiting on it', async () => {
    const stdinOut = path.join(scratch, 'stdin-empty.txt');
    const result = await runner({ FAKE_CODEX_STDIN_OUT: stdinOut }).run({ args: ['exec'] });

    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(stdinOut, 'utf8'), '');
  });

  test('runs in the requested working directory', async () => {
    const cwdOut = path.join(scratch, 'cwd.txt');
    await runner({ FAKE_CODEX_CWD_OUT: cwdOut }).run({ args: ['exec'], cwd: scratch });

    assert.equal(fs.realpathSync(fs.readFileSync(cwdOut, 'utf8')), fs.realpathSync(scratch));
  });

  test('streams events to the callback as they arrive rather than only at the end', async () => {
    const seen: CodexEvent[] = [];
    await runner().run({ args: ['exec'], onEvent: (event) => seen.push(event) });

    assert.equal(seen.length, 9);
    assert.equal(seen[0]!.type, 'thread.started');
  });

  test('captures stderr', async () => {
    const result = await runner({ FAKE_CODEX_STDERR: 'something went sideways' }).run({ args: ['exec'] });
    assert.match(result.stderr, /sideways/);
  });

  test('reports a non-zero exit code without throwing', async () => {
    const result = await runner({ FAKE_CODEX_EXIT: '3' }).run({ args: ['exec'] });

    assert.equal(result.exitCode, 3);
    assert.equal(result.aborted, false);
  });
});

describe('cancellation', () => {
  test('kills the process when the signal aborts and flags the result', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = runner({ FAKE_CODEX_SLEEP_MS: '10000' }).run({
      args: ['exec'],
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 100);
    const result = await promise;

    assert.equal(result.aborted, true);
    assert.ok(Date.now() - started < 5_000, 'abort must not wait for the process to finish on its own');
  });

  test('keeps the events collected before the abort', async () => {
    const controller = new AbortController();
    const promise = runner({ FAKE_CODEX_SLEEP_MS: '10000' }).run({
      args: ['exec'],
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 300);
    const result = await promise;

    assert.equal(result.summary.threadId, '01a0a609-147e-7632-821d-60988a5783f3');
  });

  test('escalates to a forced kill when the process ignores SIGTERM', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = createCodexRunner({
      binary: process.execPath,
      argsPrefix: [fakeCodex],
      env: { FAKE_CODEX_SLEEP_MS: '10000', FAKE_CODEX_IGNORE_TERM: '1' },
      killGraceMs: 200,
    }).run({ args: ['exec'], signal: controller.signal });

    setTimeout(() => controller.abort(), 100);
    const result = await promise;

    assert.equal(result.aborted, true);
    assert.ok(Date.now() - started < 5_000, 'a stubborn process must still be reaped');
  });
});

describe('failure modes', () => {
  test('surfaces a missing binary as a failed run, not a crash', async () => {
    const result = await createCodexRunner({ binary: 'definitely-not-a-real-binary-xyz' }).run({
      args: ['exec'],
    });

    // The OS phrases this differently per platform and per locale, so assert on
    // the shape of the failure rather than on its wording.
    assert.notEqual(result.exitCode, 0);
    assert.ok(
      result.stderr.trim() !== '' || result.errorMessage !== null,
      'the reason must reach the caller somewhere',
    );
    assert.equal(result.summary.eventCount, 0);
  });
});

describe('version probe', () => {
  test('reports the CLI version', async () => {
    assert.match((await runner().version()) ?? '', /0\.154\.0/);
  });

  test('returns null when the binary cannot be run', async () => {
    assert.equal(await createCodexRunner({ binary: 'definitely-not-a-real-binary-xyz' }).version(), null);
  });
});
