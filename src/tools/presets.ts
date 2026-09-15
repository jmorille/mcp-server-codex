/**
 * Reading and changing this instance's image presets while it runs.
 *
 * Presets specialise a deployment, and whoever configures one iterates: a
 * mascot's description gets refined, a house style gets tightened. Making that
 * cost a restart was an accident of the first implementation, not a decision.
 *
 * What *was* a decision, and is kept: a broken presets file still stops the
 * server at startup, and a rejected change here leaves the instance exactly as
 * it was. Strictness is about never running degraded, not about never changing.
 */

import type { ImagePreset } from '../images/presets.ts';
import type { PresetChanges } from '../images/store.ts';
import type { ToolContext } from './types.ts';

export interface PresetSummary {
  name: string;
  subject: string | null;
  style: string | null;
  constraints: string | null;
  use_case: string | null;
  size: string | null;
  transparent: boolean | null;
  reference_images: string[];
}

export interface PresetListResult {
  presets: PresetSummary[];
  count: number;
  /** Where they come from, so a caller can say what to edit. */
  file: string | null;
}

export interface PresetSetInput {
  name: string;
  subject?: string;
  style?: string;
  constraints?: string;
  use_case?: string;
  size?: string;
  transparent?: boolean;
  reference_images?: string[];
}

function summarise(name: string, preset: ImagePreset): PresetSummary {
  return {
    name,
    subject: preset.subject ?? null,
    style: preset.style ?? null,
    constraints: preset.constraints ?? null,
    use_case: preset.useCase ?? null,
    size: preset.size ?? null,
    transparent: preset.transparent ?? null,
    reference_images: preset.referenceImages ?? [],
  };
}

function list(context: ToolContext): PresetListResult {
  const all = context.presets.all();
  const presets = Object.entries(all).map(([name, preset]) => summarise(name, preset));

  return { presets, count: presets.length, file: context.presets.file ?? null };
}

/** What this instance currently knows, in full rather than just the names. */
export async function presetListTool(context: ToolContext): Promise<PresetListResult> {
  return list(context);
}

/** Re-read the presets file, picking up edits made outside this server. */
export async function presetReloadTool(context: ToolContext): Promise<PresetListResult> {
  context.presets.reload();
  return list(context);
}

/** Add or replace one preset, in memory and in the file behind it. */
export async function presetSetTool(context: ToolContext, input: PresetSetInput): Promise<PresetListResult> {
  // Paths are validated here rather than only at use time: a preset that names
  // art outside the allowlist would be stored happily and then fail on every
  // image made from it, far from the call that created the problem.
  const referenceImages = input.reference_images?.map((reference) => context.paths.resolve(reference));

  const preset: ImagePreset = {
    subject: input.subject,
    style: input.style,
    constraints: input.constraints,
    useCase: input.use_case,
    size: input.size,
    transparent: input.transparent,
    referenceImages,
  };

  context.presets.set(input.name, preset);
  return list(context);
}

export interface PresetUpdateInput {
  name: string;
  subject?: string | null;
  style?: string | null;
  constraints?: string | null;
  use_case?: string | null;
  size?: string | null;
  transparent?: boolean | null;
  reference_images?: string[] | null;
}

/** Change some fields of a preset, leaving the others as they are. */
export async function presetUpdateTool(context: ToolContext, input: PresetUpdateInput): Promise<PresetListResult> {
  const changes: PresetChanges = {};

  // Only the keys actually present become changes: `undefined` means "leave
  // this alone", `null` means "clear it", and the two must not be conflated.
  if ('subject' in input) changes.subject = input.subject;
  if ('style' in input) changes.style = input.style;
  if ('constraints' in input) changes.constraints = input.constraints;
  if ('use_case' in input) changes.useCase = input.use_case;
  if ('size' in input) changes.size = input.size;
  if ('transparent' in input) changes.transparent = input.transparent;
  const references = input.reference_images;
  if (references !== undefined) {
    // Resolved against the allowlist here, not only at use time: art stored in
    // a preset and rejected later would fail on every image made from it, far
    // from the call that introduced the problem.
    changes.referenceImages = references === null ? null : references.map((r) => context.paths.resolve(r));
  }

  context.presets.update(input.name, changes);
  return list(context);
}

/** Forget a preset entirely. */
export async function presetDeleteTool(context: ToolContext, input: { name: string }): Promise<PresetListResult> {
  context.presets.remove(input.name);
  return list(context);
}
