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
  /**
   * Change some fields of an existing preset, leaving the others alone.
   *
   * `null` clears a field. Distinct from `set` because restating a long
   * subject just to tweak a style is how a subject drifts.
   */
  update(name: string, changes: PresetChanges): void;
  /** Forget one preset, in memory and on disk. */
  remove(name: string): void;
  /**
   * Change some fields of an existing preset, leaving the others alone.
   *
   * `null` clears a field. Distinct from `set` because restating a long
   * subject just to tweak a style is how a subject drifts.
   */
  update(name: string, changes: PresetChanges): void;
  /** Forget one preset, in memory and on disk. */
  remove(name: string): void;
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

/** A partial change; `null` means "clear this field". */
export type PresetChanges = {
  [K in keyof ImagePreset]?: ImagePreset[K] | null;
};

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
      requireName(name);
      commit((onDisk) => ({ ...onDisk, [name]: requireNonEmpty(name, toFileShape(preset)) }));
    },

    update(name: string, changes: PresetChanges): void {
      requireName(name);

      const existing = presets[name];
      if (existing === undefined) {
        const known = Object.keys(presets);
        throw new ConfigError(
          `No preset "${name}" to modify.` +
            (known.length === 0
              ? ' This instance has none yet; use codex_preset_set to define one.'
              : ` This instance knows: ${known.join(', ')}.`),
        );
      }

      // Applied to the internal shape and serialised once, so a cleared field
      // disappears from the file rather than being written as null.
      const merged: ImagePreset = { ...existing };
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete merged[key as keyof ImagePreset];
        else if (value !== undefined) Reflect.set(merged, key, value);
      }

      commit((onDisk) => ({ ...onDisk, [name]: requireNonEmpty(name, toFileShape(merged)) }));
    },

    remove(name: string): void {
      requireFile(file);

      // Refused rather than silently successful: a typo that looks like a
      // completed cleanup is worse than an error.
      if (presets[name] === undefined) {
        throw new ConfigError(
          `No preset "${name}" to delete. This instance knows: ${Object.keys(presets).join(', ') || 'none'}.`,
        );
      }

      commit((onDisk) => {
        const next = { ...onDisk };
        delete next[name];
        return next;
      });
    },
  };

  /**
   * Validate the whole candidate set, then write it atomically.
   *
   * The order is the point: nothing is replaced and nothing is written until
   * the result is known to be valid, so a rejected change leaves both the file
   * and the live set exactly as they were.
   */
  function commit(change: (onDisk: Record<string, unknown>) => Record<string, unknown>): void {
    const target = requireFile(file);
    const next = change(readFileShape(target));
    const validated = parseImagePresets(next, target);

    // Temp file then rename, like the mailbox: a reader — or a restart — must
    // never catch this file half written.
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(temporary, target);

    presets = validated;
  }
}

function requireName(name: string): void {
  if (name.trim() === '') {
    throw new ConfigError('A preset needs a name.');
  }
}

function requireNonEmpty(name: string, entry: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(entry).length === 0) {
    throw new ConfigError(
      `Preset "${name}" would be empty. Give it at least a subject, a style or a reference image — ` +
        'an empty preset would change nothing about the images it is used for.',
    );
  }
  return entry;
}
