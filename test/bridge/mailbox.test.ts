import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openMailbox } from '../../src/bridge/mailbox.ts';
import type { Mailbox } from '../../src/bridge/mailbox.ts';

let dir: string;
let box: Mailbox;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-mbox-'));
  box = openMailbox(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('posting', () => {
  test('gives every message an id, an author and a timestamp', () => {
    const message = box.post({ from: 'claude', kind: 'question', text: 'which library?' });

    assert.ok(message.id);
    assert.equal(message.from, 'claude');
    assert.equal(message.kind, 'question');
    assert.equal(message.text, 'which library?');
    assert.equal(message.in_reply_to, null);
    assert.ok(Date.parse(message.created_at) > 0);
  });

  test('gives distinct ids to messages posted in the same millisecond', () => {
    const ids = new Set([
      box.post({ from: 'claude', kind: 'note', text: 'a' }).id,
      box.post({ from: 'claude', kind: 'note', text: 'b' }).id,
      box.post({ from: 'claude', kind: 'note', text: 'c' }).id,
    ]);
    assert.equal(ids.size, 3);
  });

  test('records what a message answers', () => {
    const question = box.post({ from: 'claude', kind: 'question', text: 'q' });
    const answer = box.post({ from: 'codex', kind: 'answer', text: 'a', inReplyTo: question.id });

    assert.equal(answer.in_reply_to, question.id);
  });

  test('creates the directory if it does not exist yet', () => {
    const nested = path.join(dir, 'deep', 'mailbox');
    const fresh = openMailbox(nested);

    assert.doesNotThrow(() => fresh.post({ from: 'claude', kind: 'note', text: 'x' }));
    assert.ok(fs.existsSync(nested));
  });

  test('rejects an empty message rather than storing a blank one', () => {
    assert.throws(() => box.post({ from: 'claude', kind: 'note', text: '   ' }), /empty/i);
  });
});

describe('reading', () => {
  test('shows each side only what the other side wrote', () => {
    box.post({ from: 'claude', kind: 'question', text: 'for codex' });
    box.post({ from: 'codex', kind: 'answer', text: 'for claude' });

    assert.deepEqual(
      box.read({ audience: 'codex' }).messages.map((m) => m.text),
      ['for codex'],
    );
    assert.deepEqual(
      box.read({ audience: 'claude' }).messages.map((m) => m.text),
      ['for claude'],
    );
  });

  test('preserves posting order', () => {
    for (const text of ['one', 'two', 'three']) box.post({ from: 'claude', kind: 'note', text });

    assert.deepEqual(
      box.read({ audience: 'codex' }).messages.map((m) => m.text),
      ['one', 'two', 'three'],
    );
  });

  test('returns only what is new since a cursor', () => {
    box.post({ from: 'claude', kind: 'note', text: 'old' });
    const first = box.read({ audience: 'codex' });
    box.post({ from: 'claude', kind: 'note', text: 'new' });

    const second = box.read({ audience: 'codex', since: first.nextCursor });
    assert.deepEqual(
      second.messages.map((m) => m.text),
      ['new'],
    );
  });

  test('advances the cursor past messages addressed to the other side', () => {
    box.post({ from: 'claude', kind: 'note', text: 'for codex' });
    box.post({ from: 'codex', kind: 'note', text: 'for claude' });

    // Both sides share one sequence; a cursor must not rewind because the last
    // message was not for this reader.
    const page = box.read({ audience: 'codex' });
    assert.equal(page.nextCursor, 2);
  });

  test('is empty on a mailbox nobody has written to', () => {
    assert.deepEqual(box.read({ audience: 'claude' }).messages, []);
  });

  test('ignores a half-written file instead of failing the read', () => {
    box.post({ from: 'claude', kind: 'note', text: 'good' });
    fs.writeFileSync(path.join(dir, '000009-broken.json'), '{ this is not json');

    assert.equal(box.read({ audience: 'codex' }).messages.length, 1);
  });
});

describe('cross-process visibility', () => {
  test('a second handle on the same directory sees what the first wrote', () => {
    // The two bridge faces are separate processes: the disk is the only thing
    // they share, so nothing may be cached in memory.
    box.post({ from: 'claude', kind: 'question', text: 'visible?' });
    const other = openMailbox(dir);

    assert.deepEqual(
      other.read({ audience: 'codex' }).messages.map((m) => m.text),
      ['visible?'],
    );
  });

  test('writes are atomic, so a reader never sees a partial message', () => {
    // Guarded by writing to a temp name and renaming; assert no stray temp
    // files survive, which is what a non-atomic write would leave behind.
    box.post({ from: 'claude', kind: 'note', text: 'x' });
    const leftovers = fs.readdirSync(dir).filter((name) => !name.endsWith('.json'));

    assert.deepEqual(leftovers, []);
  });
});

describe('waiting for an answer', () => {
  test('resolves as soon as the answer appears', async () => {
    const question = box.post({ from: 'claude', kind: 'question', text: 'q' });
    setTimeout(() => box.post({ from: 'codex', kind: 'answer', text: 'late answer', inReplyTo: question.id }), 60);

    const answer = await box.waitForReply({ to: question.id, timeoutMs: 5_000, pollMs: 20 });
    assert.equal(answer?.text, 'late answer');
  });

  test('returns an answer that was already there', async () => {
    const question = box.post({ from: 'claude', kind: 'question', text: 'q' });
    box.post({ from: 'codex', kind: 'answer', text: 'early', inReplyTo: question.id });

    const answer = await box.waitForReply({ to: question.id, timeoutMs: 1_000, pollMs: 20 });
    assert.equal(answer?.text, 'early');
  });

  test('gives up and returns null rather than hanging forever', async () => {
    const question = box.post({ from: 'claude', kind: 'question', text: 'q' });
    const started = Date.now();

    const answer = await box.waitForReply({ to: question.id, timeoutMs: 120, pollMs: 20 });

    assert.equal(answer, null);
    assert.ok(Date.now() - started >= 100, 'it must actually wait before giving up');
  });

  test('ignores an answer to a different question', async () => {
    const mine = box.post({ from: 'claude', kind: 'question', text: 'mine' });
    const other = box.post({ from: 'claude', kind: 'question', text: 'other' });
    box.post({ from: 'codex', kind: 'answer', text: 'not for you', inReplyTo: other.id });

    assert.equal(await box.waitForReply({ to: mine.id, timeoutMs: 120, pollMs: 20 }), null);
  });
});

describe('telling runs apart', () => {
  test('records which Codex run a message came from', () => {
    // One supervisor can drive several runs at once. Without this, two
    // concurrent runs are indistinguishable in the inbox and an answer can be
    // sent back to the wrong one.
    const message = box.post({ from: 'codex', kind: 'question', text: 'q', thread: 'job-7' });

    assert.equal(message.thread, 'job-7');
  });

  test('leaves the thread null when there is nothing to attribute it to', () => {
    assert.equal(box.post({ from: 'claude', kind: 'note', text: 'x' }).thread, null);
  });

  test('can read just one run out of a shared mailbox', () => {
    box.post({ from: 'codex', kind: 'note', text: 'from seven', thread: 'job-7' });
    box.post({ from: 'codex', kind: 'note', text: 'from nine', thread: 'job-9' });

    assert.deepEqual(
      box.read({ audience: 'claude', thread: 'job-7' }).messages.map((m) => m.text),
      ['from seven'],
    );
  });

  test('delivers an unaddressed message to every run', () => {
    // A message with no thread is a broadcast. Filtering it out would make
    // "stop everything" reach nobody, which is exactly when it matters most.
    box.post({ from: 'claude', kind: 'note', text: 'stop everything' });
    box.post({ from: 'claude', kind: 'note', text: 'only nine', thread: 'job-9' });

    assert.deepEqual(
      box.read({ audience: 'codex', thread: 'job-7' }).messages.map((m) => m.text),
      ['stop everything'],
    );
  });

  test('advances a filtered cursor past the runs it skipped', () => {
    box.post({ from: 'codex', kind: 'note', text: 'from seven', thread: 'job-7' });
    box.post({ from: 'codex', kind: 'note', text: 'from nine', thread: 'job-9' });

    // Same shared sequence: a per-run reader must not rewind and re-deliver.
    assert.equal(box.read({ audience: 'claude', thread: 'job-7' }).nextCursor, 2);
  });
});
