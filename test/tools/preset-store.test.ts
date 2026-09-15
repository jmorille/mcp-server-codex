import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPresetStore } from '../../src/images/store.ts';
import type { PresetStore } from '../../src/images/store.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-store-')));
  file = path.join(dir, 'presets.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(presets: unknown): void {
  fs.writeFileSync(file, typeof presets === 'string' ? presets : JSON.stringify(presets));
}

function open(configured = true): PresetStore {
  return createPresetStore(configured ? file : undefined);
}

describe('reloading presets', () => {
  test('picks up a preset added to the file since startup', () => {
    write({ a: { subject: 'first' } });
    const store = open();
    write({ a: { subject: 'first' }, b: { subject: 'second' } });

    const result = store.reload();

    assert.deepEqual(Object.keys(store.all()).sort(), ['a', 'b']);
    assert.deepEqual(result.names.sort(), ['a', 'b']);
  });

  test('picks up an edit to an existing preset', () => {
    write({ a: { subject: 'before' } });
    const store = open();
    write({ a: { subject: 'after' } });
    store.reload();

    assert.equal(store.all().a?.subject, 'after');
  });

  test('drops a preset removed from the file', () => {
    write({ a: {}, b: {} });
    const store = open();
    write({ a: {} });
    store.reload();

    assert.deepEqual(Object.keys(store.all()), ['a']);
  });

  test('keeps the working presets when the new file is broken', () => {
    // A bad edit must not leave the instance with no presets at all: that
    // would turn a typo into a silent loss of every configured subject.
    write({ a: { subject: 'still here' } });
    const store = open();
    write('{ not json');

    assert.throws(() => store.reload(), /presets\.json/);
    assert.equal(store.all().a?.subject, 'still here');
  });

  test('refuses to reload on an instance that was never given a file', () => {
    const store = open(false);

    assert.throws(() => store.reload(), /CODEX_MCP_IMAGE_PRESETS/);
  });
});

describe('adding a preset', () => {
  test('makes it usable immediately, without a restart', () => {
    write({});
    const store = open();

    store.set('mascot', { subject: 'a green character', style: 'pixel art' });

    assert.equal(store.all().mascot?.subject, 'a green character');
  });

  test('writes it to the file so it survives a restart', () => {
    write({});
    const store = open();
    store.set('mascot', { subject: 'persisted' });

    // A preset that only lived in memory would vanish on the next start, with
    // nothing saying why.
    assert.equal(createPresetStore(file).all().mascot?.subject, 'persisted');
  });

  test('persists in the snake_case the file format uses', () => {
    write({});
    open().set('mascot', { useCase: 'logo-brand', referenceImages: [path.join(dir, 'ref.png')] });

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.equal(raw.mascot?.use_case, 'logo-brand');
    assert.ok(Array.isArray(raw.mascot?.reference_images));
  });

  test('replaces an existing preset rather than merging into it', () => {
    // Merging would make it impossible to remove a field.
    write({ mascot: { subject: 's', style: 'old' } });
    const store = open();

    store.set('mascot', { subject: 's' });

    assert.equal(store.all().mascot?.style, undefined);
  });

  test('leaves the other presets alone', () => {
    write({ a: { subject: 'keep me' } });
    const store = open();
    store.set('b', { subject: 'new' });

    assert.equal(store.all().a?.subject, 'keep me');
    assert.equal(createPresetStore(file).all().a?.subject, 'keep me');
  });

  test('refuses an unknown field, as the loader does', () => {
    write({});
    const store = open();

    assert.throws(() => store.set('mascot', { styl: 'typo' } as never), /styl/);
  });

  test('refuses a preset with nothing in it', () => {
    write({});
    assert.throws(() => open().set('mascot', {}), /empty|vide|at least/i);
  });

  test('refuses a name that is not usable as a preset name', () => {
    write({});
    const store = open();

    assert.throws(() => store.set('', { subject: 's' }), /name/i);
  });

  test('says where presets come from when none is configured', () => {
    assert.throws(() => open(false).set('mascot', { subject: 's' }), /CODEX_MCP_IMAGE_PRESETS/);
  });

  test('does not corrupt the file if validation fails', () => {
    write({ a: { subject: 'intact' } });
    const store = open();

    assert.throws(() => store.set('b', { nope: 1 } as never));
    assert.deepEqual(Object.keys(createPresetStore(file).all()), ['a']);
  });

  test('still refuses to start on a missing file, and says how to create one', () => {
    // Deliberate, and not softened to make `set` more convenient: a path that
    // does not exist is almost always a typo, and starting with zero presets
    // is the exact failure this module exists to prevent. Creating an empty
    // file is one command, and it is an explicit act.
    const missing = path.join(dir, 'nope.json');

    assert.throws(() => createPresetStore(missing), /\{\}|empty/i);
  });
});

describe('a store with no file', () => {
  test('starts empty and stays usable', () => {
    assert.deepEqual(open(false).all(), {});
  });
});
