import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateImageTool } from '../../src/tools/image.ts';
import { createTestContext, completeWith } from '../helpers/context.ts';
import type { TestContext } from '../helpers/context.ts';

let ctx: TestContext;

afterEach(() => {
  ctx?.cleanup();
});

/**
 * A context whose instance was specialised with one preset, the way a
 * deployment would be.
 */
function withPresets(presets: Record<string, unknown>): TestContext {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-pre-')));
  const file = path.join(workspace, 'presets.json');
  fs.writeFileSync(file, JSON.stringify(presets));
  ctx = createTestContext({ CODEX_MCP_IMAGE_PRESETS: file, CODEX_MCP_ALLOWED_ROOTS: workspace });
  fs.mkdirSync(path.join(workspace, 'ref'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'ref', 'art.png'), 'x');
  return ctx;
}

/** The prompt actually sent to Codex on stdin. */
function prompt(c: TestContext): string {
  return c.runner.calls.at(-1)?.stdin ?? '';
}

describe('generating from a preset', () => {
  test('applies the subject the instance was configured with', async () => {
    // The whole point: a caller says "waving" and gets the full subject, without
    // the description living in this package or in every call.
    const c = withPresets({ mascot: { subject: 'a green ovoid character with leaf antennae' } });
    await completeWith(
      c.runner,
      generateImageTool(c, { preset: 'mascot', prompt: 'waving', output_path: 'out.png' }),
    );

    assert.match(prompt(c), /a green ovoid character with leaf antennae/);
    assert.match(prompt(c), /waving/);
  });

  test('fills in style, constraints, use case and size', async () => {
    const c = withPresets({
      mascot: {
        style: 'pixel art 16-bit',
        constraints: 'no watermark',
        use_case: 'stylized-concept',
        size: '1024x1024',
      },
    });
    await completeWith(c.runner, generateImageTool(c, { preset: 'mascot', prompt: 'x', output_path: 'o.png' }));

    const text = prompt(c);
    assert.match(text, /Style\/medium: pixel art 16-bit/);
    assert.match(text, /Constraints: no watermark/);
    assert.match(text, /Use case: stylized-concept/);
    assert.match(text, /Size: 1024x1024/);
  });

  test('lets an explicit argument beat the preset', async () => {
    // A preset is a default, not a lock: one call may need a different style.
    const c = withPresets({ mascot: { style: 'pixel art 16-bit' } });
    await completeWith(
      c.runner,
      generateImageTool(c, { preset: 'mascot', prompt: 'x', output_path: 'o.png', style: 'watercolour' }),
    );

    assert.match(prompt(c), /Style\/medium: watercolour/);
    assert.doesNotMatch(prompt(c), /pixel art/);
  });

  test('attaches the reference art the preset points at', async () => {
    const c = withPresets({ mascot: { reference_images: ['./ref/art.png'] } });
    await completeWith(c.runner, generateImageTool(c, { preset: 'mascot', prompt: 'x', output_path: 'o.png' }));

    const args = c.runner.calls.at(-1)?.args ?? [];
    assert.ok(
      args.some((a) => a.endsWith(`ref${path.sep}art.png`)),
      `expected the reference image in argv, got ${args.join(' ')}`,
    );
  });

  test('still enforces the allowlist on a preset reference', async () => {
    // A preset is configuration, not an exemption: it cannot smuggle in a path
    // the server was told to refuse.
    const c = withPresets({ mascot: { reference_images: [path.join(path.parse(process.cwd()).root, 'outside.png')] } });

    await assert.rejects(
      () => generateImageTool(c, { preset: 'mascot', prompt: 'x', output_path: 'o.png' }),
      /allowlist|autoris/i,
    );
  });

  test('names the presets it does know when given one it does not', async () => {
    const c = withPresets({ mascot: {}, product: {} });

    await assert.rejects(
      () => generateImageTool(c, { preset: 'nope', prompt: 'x', output_path: 'o.png' }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /nope/);
        assert.match(message, /mascot/);
        assert.match(message, /product/);
        return true;
      },
    );
  });

  test('says so plainly when the instance has no presets at all', async () => {
    ctx = createTestContext();

    await assert.rejects(
      () => generateImageTool(ctx, { preset: 'mascot', prompt: 'x', output_path: 'o.png' }),
      /no image presets|CODEX_MCP_IMAGE_PRESETS/i,
    );
  });

  test('works exactly as before when no preset is named', async () => {
    const c = withPresets({ mascot: { subject: 'should not appear' } });
    await completeWith(c.runner, generateImageTool(c, { prompt: 'a plain robot', output_path: 'o.png' }));

    assert.match(prompt(c), /a plain robot/);
    assert.doesNotMatch(prompt(c), /should not appear/);
  });
});
