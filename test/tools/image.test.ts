import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { generateImageTool, composeImagePrompt } from '../../src/tools/image.ts';
import { PathViolationError } from '../../src/security/paths.ts';
import { createTestContext } from '../helpers/context.ts';
import type { TestContext } from '../helpers/context.ts';

let ctx: TestContext;

afterEach(() => {
  ctx?.cleanup();
});

function fresh(env: Record<string, string> = {}): TestContext {
  ctx = createTestContext(env);
  return ctx;
}

describe('prompt composition', () => {
  test('emits the labelled spec the imagegen skill expects', () => {
    const prompt = composeImagePrompt({
      prompt: 'a blue robot',
      outputPath: 'C:\\work\\robot.png',
      useCase: 'logo-brand',
      size: '1024x1024',
      transparent: true,
      style: 'flat minimal',
      constraints: 'no text',
    });

    assert.match(prompt, /Use case: logo-brand/);
    assert.match(prompt, /Primary request: a blue robot/);
    assert.match(prompt, /Style\/medium: flat minimal/);
    assert.match(prompt, /Constraints: no text/);
    assert.match(prompt, /1024x1024/);
    assert.match(prompt, /transparent/i);
    assert.ok(prompt.includes('C:\\work\\robot.png'), 'the destination must be stated verbatim');
  });

  test('omits the labels it has no value for', () => {
    const prompt = composeImagePrompt({ prompt: 'a cat', outputPath: '/out/cat.png' });

    assert.doesNotMatch(prompt, /Style\/medium:/);
    assert.doesNotMatch(prompt, /Constraints:/);
    assert.match(prompt, /Primary request: a cat/);
  });

  test('defaults the use case rather than leaving it blank', () => {
    assert.match(composeImagePrompt({ prompt: 'x', outputPath: '/o.png' }), /Use case: \S+/);
  });
});

describe('codex_generate_image', () => {
  async function run(c: TestContext, input: Parameters<typeof generateImageTool>[1], onStart: () => void) {
    const promise = generateImageTool(c, input);
    await c.runner.started();
    onStart();
    c.runner.settle();
    return promise;
  }

  test('turns on the image_generation feature', async () => {
    const c = fresh();
    const out = path.join(c.workspace, 'robot.png');
    await run(c, { prompt: 'robot', output_path: out }, () => {
      fs.writeFileSync(out, 'png-bytes');
      c.runner.emit({ type: 'thread.started', thread_id: 'th-img' });
    });

    const argv = c.runner.calls[0]!.args;
    assert.deepEqual(argv.slice(argv.indexOf('--enable'), argv.indexOf('--enable') + 2), [
      '--enable',
      'image_generation',
    ]);
  });

  test('uses a writable sandbox, since the agent must save the file', async () => {
    const c = fresh({ CODEX_MCP_DEFAULT_SANDBOX: 'read-only' });
    const out = path.join(c.workspace, 'robot.png');
    await run(c, { prompt: 'robot', output_path: out }, () => {
      fs.writeFileSync(out, 'png-bytes');
    });

    const argv = c.runner.calls[0]!.args;
    assert.equal(argv[argv.indexOf('-s') + 1], 'workspace-write');
  });

  test('reports the image once it lands at the requested path', async () => {
    const c = fresh();
    const out = path.join(c.workspace, 'robot.png');
    const result = await run(c, { prompt: 'robot', output_path: out }, () => {
      fs.writeFileSync(out, 'png-bytes');
    });

    assert.equal(result.imagePath, fs.realpathSync(out));
    assert.equal(result.imageSource, 'requested-path');
    assert.ok(result.imageBytes && result.imageBytes > 0);
  });

  test('recovers the image from $CODEX_HOME/generated_images when the agent left it there', async () => {
    const c = fresh();
    const out = path.join(c.workspace, 'robot.png');

    const result = await run(c, { prompt: 'robot', output_path: out }, () => {
      c.runner.emit({ type: 'thread.started', thread_id: 'th-img' });
      // Codex's built-in image_gen tool writes here first; the copy step is the
      // model's job and it does not always happen.
      const dir = path.join(c.config.codexHome, 'generated_images', 'th-img');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'exec-abc.png'), 'png-bytes');
    });

    assert.equal(result.imageSource, 'generated-images-dir');
    assert.equal(result.imagePath, fs.realpathSync(out));
    assert.equal(fs.readFileSync(out, 'utf8'), 'png-bytes', 'the file must be copied to the destination');
  });

  test('picks the newest file when the thread produced several', async () => {
    const c = fresh();
    const out = path.join(c.workspace, 'robot.png');

    const result = await run(c, { prompt: 'robot', output_path: out }, () => {
      c.runner.emit({ type: 'thread.started', thread_id: 'th-img' });
      const dir = path.join(c.config.codexHome, 'generated_images', 'th-img');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'old.png'), 'old');
      fs.utimesSync(path.join(dir, 'old.png'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      fs.writeFileSync(path.join(dir, 'new.png'), 'new');
    });

    assert.equal(fs.readFileSync(result.imagePath as string, 'utf8'), 'new');
  });

  test('says plainly that no image was produced instead of returning a phantom path', async () => {
    const c = fresh();
    const result = await run(c, { prompt: 'robot', output_path: path.join(c.workspace, 'robot.png') }, () => {
      c.runner.emit({
        type: 'item.completed',
        item: { id: 'i0', type: 'agent_message', text: 'I could not generate that.' },
      });
    });

    assert.equal(result.imagePath, null);
    assert.equal(result.imageSource, null);
    assert.ok(
      result.errors.some((e) => /no image/i.test(e)),
      'the failure must be explicit in the errors',
    );
  });

  test('refuses a destination outside the allowlist', async () => {
    const c = fresh();
    await assert.rejects(
      () => generateImageTool(c, { prompt: 'x', output_path: path.join(c.outside, 'evil.png') }),
      PathViolationError,
    );
    assert.equal(c.runner.calls.length, 0);
  });

  test('reports no image yet when the run went to the background', async () => {
    const c = fresh();
    const result = await generateImageTool(c, {
      prompt: 'robot',
      output_path: path.join(c.workspace, 'robot.png'),
      timeout_seconds: 0,
    });

    assert.equal(result.mode, 'background');
    assert.equal(result.imagePath, null);
    c.runner.settle();
  });
});
