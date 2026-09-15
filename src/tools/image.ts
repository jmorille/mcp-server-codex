/**
 * Image generation through Codex.
 *
 * Codex exposes no image-generation endpoint: the app-server protocol has
 * `ImageGenerationThreadItem` as an *event* type but no `image/*` RPC method,
 * and there is no `codex image` subcommand. The only access is agentic — the
 * model decides to call its built-in `image_gen` tool during a turn, guided by
 * the system skill `imagegen`.
 *
 * Two consequences shape this file:
 *
 * 1. **The prompt is composed, not forwarded.** The `imagegen` skill expects a
 *    labelled spec (`Use case:` / `Primary request:` / ...). Feeding it raw
 *    user text measurably degrades the result, so we build the spec.
 * 2. **The output has to be hunted down.** `image_gen` emits no JSONL item, so
 *    the event stream never says where the file went. Codex writes to
 *    `$CODEX_HOME/generated_images/<thread_id>/` and *asks the model* to copy
 *    it to the destination — a step the model sometimes skips. We therefore
 *    check the requested path, then fall back to that directory.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { buildExecArgs } from '../codex/argv.ts';
import { runHybrid } from '../jobs/hybrid.ts';
import type { HybridOutcome } from '../jobs/hybrid.ts';
import type { ImagePreset } from '../images/presets.ts';
import { bridgeArgsFor, resolveCommon } from './common.ts';
import type { CommonToolInput } from './common.ts';
import type { ToolContext } from './types.ts';

export interface GenerateImageToolInput extends CommonToolInput {
  /** Named preset this server instance was configured with. */
  preset?: string;
  prompt: string;
  output_path: string;
  use_case?: string;
  size?: string;
  transparent?: boolean;
  style?: string;
  constraints?: string;
  reference_images?: string[];
}

export type ImageSource = 'requested-path' | 'generated-images-dir';

export interface GenerateImageResult extends HybridOutcome {
  imagePath: string | null;
  imageSource: ImageSource | null;
  imageBytes: number | null;
  composedPrompt: string;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export interface ComposeImagePromptInput {
  prompt: string;
  outputPath: string;
  useCase?: string;
  size?: string;
  transparent?: boolean;
  style?: string;
  constraints?: string;
  referenceImages?: string[];
}

/** Build the labelled spec documented by the `imagegen` skill. */
export function composeImagePrompt(input: ComposeImagePromptInput): string {
  const lines: string[] = [];

  lines.push(`Use case: ${input.useCase ?? 'stylized-concept'}`);
  lines.push(`Primary request: ${input.prompt}`);
  if (input.style) lines.push(`Style/medium: ${input.style}`);
  if (input.referenceImages?.length) {
    lines.push(
      `Input images: ${input.referenceImages.map((ref, i) => `Image ${i + 1}: reference (${ref})`).join('; ')}`,
    );
  }
  if (input.size) lines.push(`Size: ${input.size}`);
  if (input.transparent) {
    lines.push('Background: genuinely transparent; preserve the alpha channel.');
  }
  if (input.constraints) lines.push(`Constraints: ${input.constraints}`);

  lines.push('');
  // Stated as an instruction rather than a label: the destination is an action
  // for the model to take, not a property of the image.
  lines.push(
    `Save the final image to exactly this path: ${input.outputPath}`,
    'Use the built-in image_gen tool. Copy the selected output to that exact path.',
    'Do nothing else: no extra files, no edits to the repository.',
  );

  return lines.join('\n');
}

async function fileSize(candidate: string): Promise<number | null> {
  try {
    const stat = await fsp.stat(candidate);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Newest image file written by this thread, if Codex left one behind. */
async function findGeneratedImage(codexHome: string, threadId: string): Promise<string | null> {
  const dir = path.join(codexHome, 'generated_images', threadId);

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }

  const candidates = await Promise.all(
    entries
      .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .map(async (name) => {
        const full = path.join(dir, name);
        try {
          const stat = await fsp.stat(full);
          return stat.isFile() ? { full, mtime: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
  );

  const found = candidates.filter((c): c is { full: string; mtime: number } => c !== null);
  if (found.length === 0) return null;

  found.sort((a, b) => b.mtime - a.mtime);
  return (found[0] as { full: string }).full;
}

/**
 * Resolve a named preset, or fail with something the caller can act on.
 *
 * Presets are what specialises an instance: the package ships none, and a
 * deployment supplies the subjects its users draw repeatedly. So a miss here is
 * almost always a name typo or the wrong instance, and the message says which.
 */
function presetFor(context: ToolContext, name: string): ImagePreset {
  const known = Object.keys(context.presets.all());

  if (known.length === 0) {
    throw new Error(
      `This server has no image presets, so "${name}" cannot be resolved. ` +
        'Presets come from the instance: point CODEX_MCP_IMAGE_PRESETS at a JSON file, ' +
        'or call this tool without "preset" and describe the subject in the prompt.',
    );
  }

  const preset = context.presets.all()[name];
  if (preset === undefined) {
    throw new Error(`Unknown image preset "${name}". This server knows: ${known.join(', ')}.`);
  }
  return preset;
}

export async function generateImageTool(
  context: ToolContext,
  input: GenerateImageToolInput,
): Promise<GenerateImageResult> {
  // A preset supplies defaults only; anything the call states wins, so one
  // call can depart from the house style without redefining it.
  const preset = input.preset !== undefined ? presetFor(context, input.preset) : {};

  const outputPath = context.paths.resolve(input.output_path);
  // Preset references go through the allowlist like any other path: being
  // configuration does not make them exempt.
  const references = input.reference_images ?? preset.referenceImages;
  const referenceImages = references?.map((ref) => context.paths.resolve(ref));

  // The agent has to write a file, so a read-only sandbox would guarantee
  // failure. This overrides the server default on purpose.
  const common = resolveCommon(context, { ...input, sandbox: 'workspace-write' });

  const composedPrompt = composeImagePrompt({
    // The preset describes the recurring subject, the call describes this
    // particular image of it.
    prompt: preset.subject ? `${preset.subject}, ${input.prompt}` : input.prompt,
    outputPath,
    useCase: input.use_case ?? preset.useCase,
    size: input.size ?? preset.size,
    transparent: input.transparent ?? preset.transparent,
    style: input.style ?? preset.style,
    constraints: input.constraints ?? preset.constraints,
    referenceImages,
  });

  const args = buildExecArgs({
    prompt: composedPrompt,
    sandbox: 'workspace-write',
    model: input.model,
    images: referenceImages,
    config: input.config,
    enable: ['image_generation', ...(input.enable ?? [])],
    disable: input.disable,
    // Images are routinely generated outside a repository; refusing to run
    // there would be a pointless obstacle.
    skipGitRepoCheck: input.skip_git_repo_check ?? true,
  });

  const outcome = await runHybrid(context, {
    tool: 'codex_generate_image',
    args,
    stdin: composedPrompt,
    cwd: path.dirname(outputPath),
    timeoutMs: common.timeoutMs,
    argsForJob: bridgeArgsFor(context),
  });

  const base = { ...outcome, composedPrompt };

  // A backgrounded run has not produced anything yet; the caller polls the job
  // and re-checks the path itself.
  if (outcome.mode === 'background') {
    return { ...base, imagePath: null, imageSource: null, imageBytes: null };
  }

  const directSize = await fileSize(outputPath);
  if (directSize !== null) {
    return {
      ...base,
      imagePath: fs.realpathSync(outputPath),
      imageSource: 'requested-path',
      imageBytes: directSize,
    };
  }

  if (outcome.threadId) {
    const generated = await findGeneratedImage(context.config.codexHome, outcome.threadId);
    if (generated !== null) {
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.copyFile(generated, outputPath);
      return {
        ...base,
        imagePath: fs.realpathSync(outputPath),
        imageSource: 'generated-images-dir',
        imageBytes: await fileSize(outputPath),
      };
    }
  }

  return {
    ...base,
    imagePath: null,
    imageSource: null,
    imageBytes: null,
    errors: [
      ...outcome.errors,
      `No image was produced. Nothing at ${outputPath}, and nothing in ` +
        `${path.join(context.config.codexHome, 'generated_images', outcome.threadId ?? '<unknown-thread>')}. ` +
        `Codex said: ${outcome.finalMessage ?? '(no final message)'}`,
    ],
  };
}
