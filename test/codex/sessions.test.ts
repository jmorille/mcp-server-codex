import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listSessions } from '../../src/codex/sessions.ts';

let codexHome: string;

/** Write a rollout file the way Codex lays them out: sessions/YYYY/MM/DD/. */
function writeRollout(
  id: string,
  date: string,
  meta: Record<string, unknown>,
  extraLines: string[] = [],
): void {
  const [year, month, day] = date.split('-') as [string, string, string];
  const dir = path.join(codexHome, 'sessions', year, month, day);
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({
    timestamp: `${date}T10:00:00.000Z`,
    type: 'session_meta',
    payload: { session_id: id, cwd: 'C:\\work', cli_version: '0.154.0', source: 'exec', ...meta },
  });
  fs.writeFileSync(
    path.join(dir, `rollout-${date}T10-00-00-${id}.jsonl`),
    [header, ...extraLines].join('\n') + '\n',
  );
}

before(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-sessions-'));
});

after(() => {
  fs.rmSync(codexHome, { recursive: true, force: true });
});

describe('listSessions', () => {
  test('returns an empty list when nothing has been recorded yet', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-empty-'));
    assert.deepEqual(await listSessions({ codexHome: empty }), []);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  test('discovers a session that exists only as a rollout file', async () => {
    writeRollout('aaa-1', '2026-09-10', {});
    const sessions = await listSessions({ codexHome });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.id, 'aaa-1');
    assert.equal(sessions[0]!.cwd, 'C:\\work');
    assert.equal(sessions[0]!.cliVersion, '0.154.0');
    assert.equal(sessions[0]!.name, null, 'an unnamed thread has no name');
    assert.ok(sessions[0]!.rolloutPath?.endsWith('.jsonl'));
  });

  test('takes the thread name from session_index.jsonl', async () => {
    fs.writeFileSync(
      path.join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: 'aaa-1', thread_name: 'Refactor auth', updatedAt: null }).replace(
        '"updatedAt":null',
        '"updated_at":"2026-09-11T08:00:00.000Z"',
      ) + '\n',
    );

    const sessions = await listSessions({ codexHome });
    const found = sessions.find((s) => s.id === 'aaa-1');
    assert.equal(found?.name, 'Refactor auth');
    assert.equal(found?.updatedAt, '2026-09-11T08:00:00.000Z');
  });

  test('sorts the most recently updated session first', async () => {
    writeRollout('bbb-2', '2026-09-12', {});
    writeRollout('ccc-3', '2026-09-08', {});

    const ids = (await listSessions({ codexHome })).map((s) => s.id);
    assert.deepEqual(ids.slice(0, 2), ['bbb-2', 'aaa-1']);
    assert.equal(ids.at(-1), 'ccc-3');
  });

  test('honours the limit', async () => {
    assert.equal((await listSessions({ codexHome, limit: 2 })).length, 2);
  });

  test('filters by working directory', async () => {
    writeRollout('ddd-4', '2026-09-13', { cwd: 'C:\\other' });
    const sessions = await listSessions({ codexHome, cwd: 'C:\\other' });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.id, 'ddd-4');
  });

  test('filters by a case-insensitive name query', async () => {
    const sessions = await listSessions({ codexHome, query: 'refactor' });
    assert.deepEqual(
      sessions.map((s) => s.id),
      ['aaa-1'],
    );
  });

  test('skips a corrupt line in the index instead of failing the whole listing', async () => {
    fs.appendFileSync(path.join(codexHome, 'session_index.jsonl'), 'this is not json\n');
    const sessions = await listSessions({ codexHome });
    assert.ok(sessions.length >= 4, 'the valid entries must still come back');
  });

  test('tolerates a rollout whose first line is not a session_meta header', async () => {
    const dir = path.join(codexHome, 'sessions', '2026', '09', '14');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-09-14T10-00-00-eee-5.jsonl'), 'garbage\n');

    const sessions = await listSessions({ codexHome });
    assert.ok(!sessions.some((s) => s.id === 'eee-5'));
    assert.ok(sessions.length >= 4);
  });

  test('reads only the header, not the whole rollout', async () => {
    // A rollout can reach tens of megabytes; a listing must not pay for that.
    const huge = 'x'.repeat(2_000_000);
    writeRollout('fff-6', '2026-09-15', {}, [JSON.stringify({ type: 'noise', blob: huge })]);

    const started = Date.now();
    const sessions = await listSessions({ codexHome });
    assert.ok(sessions.some((s) => s.id === 'fff-6'));
    assert.ok(Date.now() - started < 2_000, 'listing should not slurp entire rollouts');
  });
});
