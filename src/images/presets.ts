/**
 * Named image presets, supplied by whoever configured this server instance.
 *
 * The package stays general; a deployment specialises it. An instance
 * registered for one team points `CODEX_MCP_IMAGE_PRESETS` at a file holding
 * the subjects that team draws over and over — a mascot, a product, a house
 * style — and callers name a preset instead of restating the description on
 * every call. Nothing about any particular subject lives in this package.
 *
 * Presets are read once, at startup, and a bad file stops the server rather
 * than degrading it: a preset that silently failed to load produces generic
 * images that look like a model failure, and nobody would think to check the
 * configuration.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ConfigError } from '../config.ts';

export interface ImagePreset {
  /** Description of the subject, prepended to whatever the caller asks for. */
  subject?: string;
  style?: string;
  constraints?: string;
  useCase?: string;
  size?: string;
  transparent?: boolean;
  /** Reference art, resolved against the preset file's own directory. */
  referenceImages?: string[];
}

export type ImagePresets = Record<string, ImagePreset>;

/** Every key a preset may carry, in the snake_case the file uses. */
const FIELDS = new Set([
  'subject',
  'style',
  'constraints',
  'use_case',
  'size',
  'transparent',
  'reference_images',
]);

function asString(value: unknown, field: string, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ConfigError(`Preset "${name}": ${field} must be a string.`);
  }
  return value;
}

export function loadImagePresets(file: string | undefined): ImagePresets {
  if (file === undefined || file.trim() === '') return {};

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `CODEX_MCP_IMAGE_PRESETS points at "${file}", which cannot be read. ` +
        'Fix the path, unset the variable, or create the file with an empty {} if you mean to ' +
        'add presets later with codex_preset_set.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `Image presets in "${file}" are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseImagePresets(parsed, file);
}

/**
 * Validate an already-parsed set of presets.
 *
 * Separate from reading the file so a candidate set can be checked *before* it
 * replaces the live one: a rejected edit must leave the instance exactly as it
 * was, not empty it.
 */
export function parseImagePresets(parsed: unknown, file: string): ImagePresets {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`Image presets in "${file}" must be an object mapping a preset name to its settings.`);
  }

  // Relative references belong to the file that declares them: the preset and
  // its reference art travel together, while the server's working directory is
  // incidental and changes with however it was launched.
  const base = path.dirname(path.resolve(file));
  const presets: ImagePresets = {};

  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ConfigError(`Preset "${name}" must be an object of settings.`);
    }
    const entry = value as Record<string, unknown>;

    // A misspelled field that is quietly ignored produces images that are
    // subtly wrong, with nothing anywhere explaining why.
    for (const key of Object.keys(entry)) {
      if (!FIELDS.has(key)) {
        throw new ConfigError(
          `Preset "${name}" has an unknown field "${key}". Known fields: ${[...FIELDS].join(', ')}.`,
        );
      }
    }

    const references = entry.reference_images;
    if (references !== undefined && !Array.isArray(references)) {
      throw new ConfigError(`Preset "${name}": reference_images must be an array of paths.`);
    }
    if (entry.transparent !== undefined && typeof entry.transparent !== 'boolean') {
      throw new ConfigError(`Preset "${name}": transparent must be true or false.`);
    }

    presets[name] = {
      subject: asString(entry.subject, 'subject', name),
      style: asString(entry.style, 'style', name),
      constraints: asString(entry.constraints, 'constraints', name),
      useCase: asString(entry.use_case, 'use_case', name),
      size: asString(entry.size, 'size', name),
      transparent: entry.transparent as boolean | undefined,
      referenceImages: (references as string[] | undefined)?.map((reference) => {
        if (typeof reference !== 'string') {
          throw new ConfigError(`Preset "${name}": reference_images must contain paths.`);
        }
        return path.isAbsolute(reference) ? reference : path.resolve(base, reference);
      }),
    };
  }

  return presets;
}
