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

  test('hands each message over once and only once', () => {
    box.post({ from: 'claude', kind: 'note', text: 'old' });
    box.read({ audience: 'codex' });
    box.post({ from: 'claude', kind: 'note', text: 'new' });

    assert.deepEqual(
      box.read({ audience: 'codex' }).messages.map((m) => m.text),
      ['new'],
    );
  });

  test('consuming one side does not consume the other', () => {
    // Both sides share one directory. Reading as Codex must not mark Claude's
    // own backlog as delivered, or the other reader would never see it.
    box.post({ from: 'claude', kind: 'note', text: 'for codex' });
    box.post({ from: 'codex', kind: 'note', text: 'for claude' });

    box.read({ audience: 'codex' });

    assert.deepEqual(
      box.read({ audience: 'claude' }).messages.map((m) => m.text),
      ['for claude'],
    );
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

  test('reading one run leaves another run still deliverable', () => {
    // Watching job-7 must not silently swallow job-9's traffic: a per-run read
    // that consumed everything would lose the other run's messages for good.
    box.post({ from: 'codex', kind: 'note', text: 'from seven', thread: 'job-7' });
    box.post({ from: 'codex', kind: 'note', text: 'from nine', thread: 'job-9' });

    box.read({ audience: 'claude', thread: 'job-7' });

    assert.deepEqual(
      box.read({ audience: 'claude', thread: 'job-9' }).messages.map((m) => m.text),
      ['from nine'],
    );
  });
});

describe('the cursor survives two processes writing at once', () => {
  test('never skips a message posted by the other process in the same millisecond', () => {
    // The file name carried a per-process counter, but two processes share the
    // directory: the bridge (counter at 1) sorted BEFORE a long-lived server
    // (counter at 13), so a question landed behind a cursor already past it and
    // was never delivered. Codex then blocked for its whole timeout.
    const other = openMailbox(dir);
    for (let i = 0; i < 12; i += 1) box.post({ from: 'claude', kind: 'note', text: `old ${i}` });

    const realNow = Date.now;
    Date.now = () => 1_789_500_000_000;
    try {
      box.post({ from: 'claude', kind: 'note', text: 'from claude' });
      const first = box.read({ audience: 'claude' });
      other.post({ from: 'codex', kind: 'question', text: 'from codex' });
      const second = box.read({ audience: 'claude', since: first.nextCursor });

      assert.deepEqual(
        second.messages.map((m) => m.text),
        ['from codex'],
        'a message written by the other process must not fall behind the cursor',
      );
    } finally {
      Date.now = realNow;
    }
  });

  test('still delivers each message exactly once across many interleaved reads', () => {
    const other = openMailbox(dir);
    const realNow = Date.now;
    Date.now = () => 1_789_500_000_000;

    const seen: string[] = [];
    let cursor;
    try {
      for (let i = 0; i < 20; i += 1) {
        (i % 2 === 0 ? box : other).post({ from: 'codex', kind: 'note', text: `m${i}` });
        const page = box.read({ audience: 'claude', since: cursor });
        seen.push(...page.messages.map((m) => m.text));
        cursor = page.nextCursor;
      }
    } finally {
      Date.now = realNow;
    }

    assert.equal(new Set(seen).size, 20, 'every message must be delivered');
    assert.equal(seen.length, 20, 'and none of them twice');
  });
});
