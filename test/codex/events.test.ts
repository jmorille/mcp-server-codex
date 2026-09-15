import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEventAccumulator } from '../../src/codex/events.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const realRun = fs.readFileSync(path.join(fixturesDir, 'imagegen-run.jsonl'), 'utf8');

describe('line framing', () => {
  test('reassembles a JSON object split across two chunks', () => {
    const acc = createEventAccumulator();
    const first = acc.ingest('{"type":"thread.star');
    assert.deepEqual(first, []);
    const second = acc.ingest('ted","thread_id":"abc"}\n');
    assert.equal(second.length, 1);
    assert.equal(acc.summary().threadId, 'abc');
  });

  test('tolerates CRLF line endings', () => {
    const acc = createEventAccumulator();
    acc.ingest('{"type":"turn.started"}\r\n{"type":"turn.completed"}\r\n');
    assert.equal(acc.summary().eventCount, 2);
  });

  test('emits a trailing line that arrived without a newline once ended', () => {
    const acc = createEventAccumulator();
    acc.ingest('{"type":"thread.started","thread_id":"xyz"}');
    assert.equal(acc.summary().threadId, null);
    acc.end();
    assert.equal(acc.summary().threadId, 'xyz');
  });

  test('records a non-JSON line as noise instead of throwing', () => {
    const acc = createEventAccumulator();
    acc.ingest('Reading additional input from stdin...\n{"type":"turn.started"}\n');
    assert.deepEqual(acc.summary().unparsedLines, ['Reading additional input from stdin...']);
    assert.equal(acc.summary().eventCount, 1);
  });

  test('ignores blank lines', () => {
    const acc = createEventAccumulator();
    acc.ingest('\n\n{"type":"turn.started"}\n\n');
    assert.equal(acc.summary().eventCount, 1);
    assert.deepEqual(acc.summary().unparsedLines, []);
  });
});

describe('summary over a real codex exec run', () => {
  const summarise = () => {
    const acc = createEventAccumulator();
    acc.ingest(realRun);
    acc.end();
    return acc.summary();
  };

  test('captures the thread id', () => {
    assert.equal(summarise().threadId, '01a0a609-147e-7632-821d-60988a5783f3');
  });

  test('collects agent messages in order and exposes the last as the final message', () => {
    const s = summarise();
    assert.equal(s.messages.length, 2);
    assert.match(s.messages[0]!, /generation d/);
    // Windows paths survive the JSONL round-trip with their backslashes intact.
    assert.equal(s.finalMessage, String.raw`[robot.png](C:\workspace\robot.png)`);
  });

  test('merges each command_execution into a single entry keyed by item id', () => {
    const s = summarise();
    assert.equal(s.commands.length, 2, 'started + completed must not double-count');
    assert.deepEqual(
      s.commands.map((c) => c.exitCode),
      [0, 0],
      'the completed state must win over the in_progress one',
    );
    assert.equal(s.commands[0]!.status, 'completed');
    assert.match(s.commands[0]!.output, /Image Generation Skill/);
  });

  test('maps usage into camelCase', () => {
    assert.deepEqual(summarise().usage, {
      inputTokens: 78773,
      cachedInputTokens: 67328,
      cacheWriteInputTokens: 0,
      outputTokens: 682,
      reasoningOutputTokens: 62,
    });
  });

  test('counts every parsed event', () => {
    assert.equal(summarise().eventCount, 9);
  });
});

describe('resilience to codex version drift', () => {
  test('keeps an item whose type is unknown rather than dropping it', () => {
    const acc = createEventAccumulator();
    acc.ingest('{"type":"item.completed","item":{"id":"i9","type":"some_future_thing","payload":42}}\n');
    const items = acc.summary().items;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.type, 'some_future_thing');
    assert.equal((items[0]! as Record<string, unknown>).payload, 42);
  });

  test('collects error events', () => {
    const acc = createEventAccumulator();
    acc.ingest('{"type":"error","message":"usage limit exceeded"}\n');
    assert.deepEqual(acc.summary().errors, ['usage limit exceeded']);
  });

  test('treats turn.failed as an error', () => {
    const acc = createEventAccumulator();
    acc.ingest('{"type":"turn.failed","error":{"message":"sandbox denied"}}\n');
    assert.deepEqual(acc.summary().errors, ['sandbox denied']);
  });

  test('records an error item as an error', () => {
    const acc = createEventAccumulator();
    acc.ingest('{"type":"item.completed","item":{"id":"i1","type":"error","message":"boom"}}\n');
    assert.deepEqual(acc.summary().errors, ['boom']);
  });
});
