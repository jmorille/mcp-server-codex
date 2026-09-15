import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadImagePresets } from '../../src/images/presets.ts';
import { ConfigError } from '../../src/config.ts';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-presets-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writePresets(content: unknown): string {
  const file = path.join(dir, 'presets.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

describe('loading image presets', () => {
  test('is empty when the server was not given any', () => {
    assert.deepEqual(loadImagePresets(undefined), {});
  });

  test('reads the named presets an instance was configured with', () => {
    const file = writePresets({
      mascot: { subject: 'a green ovoid character', style: 'pixel art 16-bit', use_case: 'stylized-concept' },
    });

    const presets = loadImagePresets(file);

    assert.deepEqual(Object.keys(presets), ['mascot']);
    assert.equal(presets.mascot?.subject, 'a green ovoid character');
    assert.equal(presets.mascot?.style, 'pixel art 16-bit');
    assert.equal(presets.mascot?.useCase, 'stylized-concept');
  });

  test('resolves reference images against the preset file, not the server cwd', () => {
    // The preset and its reference art are shipped together by whoever
    // configured the instance; resolving against the process cwd would break
    // the moment the server is started from anywhere else.
    fs.mkdirSync(path.join(dir, 'ref'));
    const file = writePresets({ mascot: { reference_images: ['./ref/art.png'] } });

    const presets = loadImagePresets(file);

    assert.deepEqual(presets.mascot?.referenceImages, [path.join(dir, 'ref', 'art.png')]);
  });

  test('leaves an absolute reference image alone', () => {
    const absolute = path.join(dir, 'elsewhere', 'art.png');
    const file = writePresets({ mascot: { reference_images: [absolute] } });

    assert.deepEqual(loadImagePresets(file).mascot?.referenceImages, [absolute]);
  });

  test('refuses to start on a file that does not exist', () => {
    // Silently running without the presets would produce generic images that
    // look like a model failure rather than a configuration mistake.
    assert.throws(() => loadImagePresets(path.join(dir, 'missing.json')), ConfigError);
  });

  test('refuses to start on malformed JSON, naming the file', () => {
    const file = writePresets('{ not json');

    assert.throws(() => loadImagePresets(file), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /presets\.json/);
      return true;
    });
  });

  test('refuses a preset that is not an object', () => {
    assert.throws(() => loadImagePresets(writePresets({ mascot: 'just a string' })), ConfigError);
  });

  test('refuses an unknown field rather than ignoring a typo', () => {
    // A misspelled "style" that is quietly dropped produces images that are
    // subtly wrong, with nothing anywhere saying why.
    assert.throws(
      () => loadImagePresets(writePresets({ mascot: { styl: 'pixel art' } })),
      /styl/,
    );
  });

  test('carries every field the image tool can default', () => {
    const file = writePresets({
      mascot: {
        subject: 's',
        style: 'st',
        constraints: 'c',
        use_case: 'u',
        size: '1024x1024',
        transparent: true,
      },
    });

    const preset = loadImagePresets(file).mascot;

    assert.equal(preset?.constraints, 'c');
    assert.equal(preset?.size, '1024x1024');
    assert.equal(preset?.transparent, true);
  });
});
