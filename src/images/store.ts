/**
 * The live set of image presets.
 *
 * Presets started as startup-only configuration, which was right for failing
 * loudly on a broken file and wrong for everything else: whoever configures an
 * instance iterates on a subject — a mascot's description, a house style — and
 * a restart per edit is a poor loop. This store keeps the strict validation and
 * adds the two operations that loop needs: reload from disk, and write a preset
 * back to it.
 *
 * Two invariants hold whatever happens:
 *
 * - **A failed change never degrades the instance.** Validation runs before
 *   anything is replaced, so a broken edit leaves the working presets in place
 *   rather than emptying them silently.
 * - **Memory and disk agree.** A preset added here is written to the file, so
 *   it is still there after a restart. A preset that only lived in memory would
 *   vanish with nothing saying why.
 */

import fs from 'node:fs';

import { ConfigError } from '../config.ts';
import { loadImagePresets, parseImagePresets } from './presets.ts';
import type { ImagePreset, ImagePresets } from './presets.ts';

export interface PresetStore {
  /** Every preset this instance currently knows. */
  all(): ImagePresets;
  /** Re-read the configured file. Throws, and changes nothing, if it is unusable. */
  reload(): { count: number; names: string[] };
  /** Add or replace one preset, in memory and on disk. */
  set(name: string, preset: ImagePreset): void;
  /** The file backing this store, when the instance was given one. */
  readonly file: string | undefined;
}

function requireFile(file: string | undefined): string {
  if (file === undefined || file.trim() === '') {
    throw new ConfigError(
      'This server has no image presets file, so presets cannot be read back or changed. ' +
        'Start it with CODEX_MCP_IMAGE_PRESETS pointing at a JSON file — it may be a path that ' +
        'does not exist yet.',
    );
  }
  return file;
}

/** Back to the snake_case the file speaks; the camelCase is internal only. */
function toFileShape(preset: ImagePreset): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (preset.subject !== undefined) entry.subject = preset.subject;
  if (preset.style !== undefined) entry.style = preset.style;
  if (preset.constraints !== undefined) entry.constraints = preset.constraints;
  if (preset.useCase !== undefined) entry.use_case = preset.useCase;
  if (preset.size !== undefined) entry.size = preset.size;
  if (preset.transparent !== undefined) entry.transparent = preset.transparent;
  if (preset.referenceImages !== undefined) entry.reference_images = preset.referenceImages;
  return entry;
}

function readFileShape(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // Nothing on disk yet is not an error here: an operator may name a path and
    // let the first `set` create it.
    return {};
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`Image presets in "${file}" must be an object mapping a preset name to its settings.`);
  }
  return parsed as Record<string, unknown>;
}

export function createPresetStore(file: string | undefined): PresetStore {
  let presets = loadImagePresets(file);

  return {
    file,

    all(): ImagePresets {
      return presets;
    },

    reload(): { count: number; names: string[] } {
      const target = requireFile(file);

      // Parsed into a local first: if the file is broken, the exception escapes
      // before the working presets are touched.
      const next = loadImagePresets(target);
      presets = next;

      const names = Object.keys(next);
      return { count: names.length, names };
    },

    set(name: string, preset: ImagePreset): void {
      if (name.trim() === '') {
        throw new ConfigError('A preset needs a name.');
      }

      const entry = toFileShape(preset);
      if (Object.keys(entry).length === 0) {
        throw new ConfigError(
          `Preset "${name}" is empty. Give it at least a subject, a style or a reference image — ` +
            'an empty preset would change nothing about the images it is used for.',
        );
      }

      const target = requireFile(file);
      const onDisk = readFileShape(target);

      // Validated as a whole before anything is written, so a rejected preset
      // leaves both the file and the live set exactly as they were.
      const merged = { ...onDisk, [name]: entry };
      const validated = parseImagePresets(merged, target);

      // Atomic, like the mailbox: a reader — or a restart — must never catch
      // this file half written.
      const temporary = `${target}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`);
      fs.renameSync(temporary, target);

      presets = validated;
    },
  };
}
