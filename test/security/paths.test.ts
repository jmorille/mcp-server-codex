import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPathPolicy, PathViolationError } from '../../src/security/paths.ts';

let root: string;
let outside: string;

before(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-paths-'));
  root = path.join(base, 'workspace');
  outside = path.join(base, 'elsewhere');
  fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
});

after(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('createPathPolicy', () => {
  test('rejects construction with an empty root list', () => {
    assert.throws(() => createPathPolicy([]), /at least one root/i);
  });

  test('rejects construction with a relative root', () => {
    assert.throws(() => createPathPolicy(['./relative']), /absolute/i);
  });
});

describe('PathPolicy.resolve', () => {
  test('accepts a directory nested inside a root', () => {
    const policy = createPathPolicy([root]);
    const resolved = policy.resolve(path.join(root, 'sub', 'deep'));
    assert.equal(resolved, fs.realpathSync(path.join(root, 'sub', 'deep')));
  });

  test('accepts the root itself', () => {
    const policy = createPathPolicy([root]);
    assert.equal(policy.resolve(root), fs.realpathSync(root));
  });

  test('accepts a path that does not exist yet when its parent is inside a root', () => {
    const policy = createPathPolicy([root]);
    const target = path.join(root, 'sub', 'not-created-yet.png');
    assert.equal(policy.resolve(target), path.join(fs.realpathSync(path.join(root, 'sub')), 'not-created-yet.png'));
  });

  test('rejects a path outside every root', () => {
    const policy = createPathPolicy([root]);
    assert.throws(() => policy.resolve(outside), PathViolationError);
  });

  test('rejects traversal that escapes the root', () => {
    const policy = createPathPolicy([root]);
    assert.throws(() => policy.resolve(path.join(root, '..', 'elsewhere')), PathViolationError);
  });

  test('rejects a sibling directory sharing the root name as a prefix', () => {
    const policy = createPathPolicy([root]);
    const sibling = root + '-evil';
    fs.mkdirSync(sibling, { recursive: true });
    assert.throws(() => policy.resolve(sibling), PathViolationError);
  });

  test('names the offending path and the allowed roots in the error', () => {
    const policy = createPathPolicy([root]);
    try {
      policy.resolve(outside);
      assert.fail('expected a PathViolationError');
    } catch (err) {
      assert.ok(err instanceof PathViolationError);
      assert.match(err.message, /elsewhere/);
      assert.match(err.message, /workspace/);
    }
  });

  test('resolves a relative path against the first root rather than process.cwd()', () => {
    const policy = createPathPolicy([root]);
    assert.equal(policy.resolve('sub'), fs.realpathSync(path.join(root, 'sub')));
  });

  test('accepts several roots and honours each of them', () => {
    const policy = createPathPolicy([root, outside]);
    assert.equal(policy.resolve(outside), fs.realpathSync(outside));
    assert.equal(policy.resolve(root), fs.realpathSync(root));
  });
});
