import { z } from 'zod';
import { demoV2Hash } from '../hash.js';
import {
  experiencePlanDataSchema, type ExperiencePlanData,
} from '../orchestration-types.js';
import {
  revisionOperationSchema, type DemoV2RevisionOperation, type RevisionOperation,
} from './visual-review.js';

/**
 * Controlled revision execution. ONLY the twelve allowed presentation operations may be applied,
 * and only within bounds. Everything that would introduce new facts, services, people, statistics,
 * URLs, contact channels, images, arbitrary HTML/CSS/JS, or unsupported components is rejected.
 *
 * Presentation operations never touch content or asset evidence bindings — they change layout,
 * variant, spacing, typography scale, crop/focal/overlay, CTA prominence, line length, an
 * already-approved copy alternative, gallery composition, or mobile stacking. Applying a revision
 * produces a NEW plan + overlay; the caller creates a new render version, new screenshots/hashes,
 * preserves prior versions, and invalidates the previous review's eligibility.
 */

export const DEMO_V2_PRESENTATION_OVERLAY_VERSION = 'demo-v2-presentation-overlay-1';

export const SPACING_DENSITIES = ['COMPACT', 'COMFORTABLE', 'SPACIOUS'] as const;
export const CTA_PROMINENCES = ['SUBTLE', 'STANDARD', 'PROMINENT'] as const;
export const GALLERY_COMPOSITIONS = ['GRID', 'MASONRY', 'CAROUSEL'] as const;
export const MOBILE_STACKINGS = ['STACKED', 'PRIORITY', 'REVERSE'] as const;

export const TYPOGRAPHY_SCALE_BOUNDS = [0.85, 1.15] as const;
export const ASSET_ASPECT_RATIO_BOUNDS = [0.5, 2.5] as const;
export const OVERLAY_STRENGTH_BOUNDS = [0, 1] as const;
export const LINE_LENGTH_CH_BOUNDS = [45, 80] as const;

const sectionPresentationSchema = z.object({
  spacingDensity: z.enum(SPACING_DENSITIES).optional(),
  typographyScale: z.number().min(TYPOGRAPHY_SCALE_BOUNDS[0]).max(TYPOGRAPHY_SCALE_BOUNDS[1]).optional(),
  assetAspectRatio: z.number().min(ASSET_ASPECT_RATIO_BOUNDS[0]).max(ASSET_ASPECT_RATIO_BOUNDS[1]).optional(),
  focalPoint: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  overlayStrength: z.number().min(OVERLAY_STRENGTH_BOUNDS[0]).max(OVERLAY_STRENGTH_BOUNDS[1]).optional(),
  ctaProminence: z.enum(CTA_PROMINENCES).optional(),
  lineLengthCh: z.number().int().min(LINE_LENGTH_CH_BOUNDS[0]).max(LINE_LENGTH_CH_BOUNDS[1]).optional(),
  copyAlternativeId: z.string().min(1).optional(),
  galleryComposition: z.enum(GALLERY_COMPOSITIONS).optional(),
  mobileStacking: z.enum(MOBILE_STACKINGS).optional(),
});
export type SectionPresentation = z.infer<typeof sectionPresentationSchema>;

export const presentationOverlaySchema = z.object({
  version: z.literal(DEMO_V2_PRESENTATION_OVERLAY_VERSION),
  sections: z.record(z.string().min(1), sectionPresentationSchema),
});
export type PresentationOverlay = z.infer<typeof presentationOverlaySchema>;

export function emptyOverlay(): PresentationOverlay {
  return { version: DEMO_V2_PRESENTATION_OVERLAY_VERSION, sections: {} };
}

/** Constraints derived once from the current plan + registry; the executor may not exceed them. */
export interface RevisionConstraints {
  /** The render hash every operation must be bound to (evidence binding preserved). */
  boundRenderHash: string;
  /** Stable section anchors, in plan order. */
  anchors: readonly string[];
  /** Allowed component variants per anchor (from the component registry for that family). */
  allowedVariants: Readonly<Record<string, readonly string[]>>;
  /** Pre-approved copy alternative ids per anchor (from the content package). Free text is refused. */
  approvedCopyAlternatives: Readonly<Record<string, readonly string[]>>;
}

/** Derive a stable, deterministic anchor for each plan section (family + dedupe suffix). */
export function deriveSectionAnchors(plan: ExperiencePlanData): string[] {
  const taken = new Map<string, number>();
  return [...plan.sections]
    .sort((a, b) => a.order - b.order)
    .map((section) => {
      const base = section.componentFamily;
      const seen = taken.get(base) ?? 0;
      taken.set(base, seen + 1);
      return seen === 0 ? base : `${base}-${String(seen + 1)}`;
    });
}

function reject(reason: string): never {
  throw new Error(`demo_v2_revision_rejected:${reason}`);
}

function requireString(op: DemoV2RevisionOperation, key: string): string {
  const value = op.parameters[key];
  if (typeof value !== 'string') reject(`missing_string_parameter:${op.operation}:${key}`);
  return value;
}

function requireNumber(op: DemoV2RevisionOperation, key: string): number {
  const value = op.parameters[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) reject(`missing_number_parameter:${op.operation}:${key}`);
  return value;
}

function requireEnum<T extends string>(op: DemoV2RevisionOperation, key: string, allowed: readonly T[]): T {
  const value = requireString(op, key);
  if (!(allowed as readonly string[]).includes(value)) reject(`value_out_of_bounds:${op.operation}:${key}`);
  return value as T;
}

function requireBoundedNumber(op: DemoV2RevisionOperation, key: string, bounds: readonly [number, number], integer = false): number {
  const value = requireNumber(op, key);
  if (value < bounds[0] || value > bounds[1]) reject(`value_out_of_bounds:${op.operation}:${key}`);
  if (integer && !Number.isInteger(value)) reject(`value_out_of_bounds:${op.operation}:${key}`);
  return value;
}

interface ApplyState {
  plan: ExperiencePlanData;
  overlay: PresentationOverlay;
}

function overlayFor(overlay: PresentationOverlay, anchor: string): SectionPresentation {
  overlay.sections[anchor] ??= {};
  return overlay.sections[anchor];
}

/** Apply ONE allowed operation. Plan-level ops (order/variant) return a new plan; the rest mutate the overlay. */
function applyOne(state: ApplyState, op: DemoV2RevisionOperation, constraints: RevisionConstraints): ApplyState {
  // Structural rejection first: markup/URLs/contacts in any parameter, unknown operation.
  const structural = revisionOperationSchema.safeParse(op);
  if (!structural.success) reject('forbidden_parameter_content');
  if (op.boundRenderHash !== constraints.boundRenderHash) reject('stale_render_binding');

  const anchor = op.targetSectionAnchor;
  if (!constraints.anchors.includes(anchor)) reject(`unknown_section_anchor:${anchor}`);

  const anchors = deriveSectionAnchors(state.plan);
  const index = anchors.indexOf(anchor);
  if (index < 0) reject(`unknown_section_anchor:${anchor}`);

  switch (op.operation) {
    case 'SECTION_ORDER': {
      const position = requireBoundedNumber(op, 'position', [1, state.plan.sections.length], true);
      const ordered = [...state.plan.sections].sort((a, b) => a.order - b.order);
      const [moved] = ordered.splice(index, 1);
      if (!moved) reject('unknown_section_anchor');
      ordered.splice(position - 1, 0, moved);
      const plan = experiencePlanDataSchema.parse({
        ...state.plan,
        sections: ordered.map((section, i) => ({ ...section, order: i + 1 })),
      });
      return { plan, overlay: state.overlay };
    }
    case 'COMPONENT_VARIANT': {
      const variant = requireString(op, 'variant');
      const allowed = constraints.allowedVariants[anchor] ?? [];
      if (!allowed.includes(variant)) reject(`unsupported_component_variant:${variant}`);
      const ordered = [...state.plan.sections].sort((a, b) => a.order - b.order);
      const target = ordered[index];
      if (!target) reject('unknown_section_anchor');
      ordered[index] = { ...target, componentVariant: variant };
      const plan = experiencePlanDataSchema.parse({ ...state.plan, sections: ordered });
      return { plan, overlay: state.overlay };
    }
    case 'SPACING_DENSITY':
      overlayFor(state.overlay, anchor).spacingDensity = requireEnum(op, 'density', SPACING_DENSITIES);
      return state;
    case 'TYPOGRAPHY_SCALE':
      overlayFor(state.overlay, anchor).typographyScale = requireBoundedNumber(op, 'scale', TYPOGRAPHY_SCALE_BOUNDS);
      return state;
    case 'ASSET_CROP':
      overlayFor(state.overlay, anchor).assetAspectRatio = requireBoundedNumber(op, 'aspectRatio', ASSET_ASPECT_RATIO_BOUNDS);
      return state;
    case 'FOCAL_POINT':
      overlayFor(state.overlay, anchor).focalPoint = {
        x: requireBoundedNumber(op, 'x', [0, 1]),
        y: requireBoundedNumber(op, 'y', [0, 1]),
      };
      return state;
    case 'OVERLAY_STRENGTH':
      overlayFor(state.overlay, anchor).overlayStrength = requireBoundedNumber(op, 'strength', OVERLAY_STRENGTH_BOUNDS);
      return state;
    case 'CTA_PROMINENCE':
      overlayFor(state.overlay, anchor).ctaProminence = requireEnum(op, 'prominence', CTA_PROMINENCES);
      return state;
    case 'LINE_LENGTH':
      overlayFor(state.overlay, anchor).lineLengthCh = requireBoundedNumber(op, 'ch', LINE_LENGTH_CH_BOUNDS, true);
      return state;
    case 'APPROVED_COPY_ALTERNATIVE': {
      const alternativeId = requireString(op, 'alternativeId');
      const approved = constraints.approvedCopyAlternatives[anchor] ?? [];
      if (!approved.includes(alternativeId)) reject(`unapproved_copy_alternative:${alternativeId}`);
      overlayFor(state.overlay, anchor).copyAlternativeId = alternativeId;
      return state;
    }
    case 'GALLERY_COMPOSITION':
      overlayFor(state.overlay, anchor).galleryComposition = requireEnum(op, 'composition', GALLERY_COMPOSITIONS);
      return state;
    case 'MOBILE_STACKING':
      overlayFor(state.overlay, anchor).mobileStacking = requireEnum(op, 'stacking', MOBILE_STACKINGS);
      return state;
    default:
      return reject(`unsupported_operation:${String(op.operation as RevisionOperation)}`);
  }
}

export interface RevisionExecutionInput {
  plan: ExperiencePlanData;
  overlay?: PresentationOverlay;
  operations: readonly DemoV2RevisionOperation[];
  constraints: RevisionConstraints;
  /** Operations the reviewer permitted for THIS cycle; any op outside this set is refused. */
  permittedOperations: readonly RevisionOperation[];
}

export interface RevisionExecutionResult {
  plan: ExperiencePlanData;
  overlay: PresentationOverlay;
  planHash: string;
  overlayHash: string;
  appliedOperations: number;
}

/**
 * Apply a bounded batch of permitted revision operations. Throws `demo_v2_revision_rejected:<reason>`
 * on the first forbidden operation, out-of-bounds value, unknown anchor, or op the reviewer did not
 * permit — nothing partial is returned. The returned plan re-validates against the plan schema.
 */
export function executeRevision(input: RevisionExecutionInput): RevisionExecutionResult {
  if (input.operations.length === 0) reject('no_operations');
  if (input.operations.length > 12) reject('too_many_operations');

  const permitted = new Set(input.permittedOperations);
  let state: ApplyState = {
    plan: experiencePlanDataSchema.parse(input.plan),
    overlay: presentationOverlaySchema.parse(input.overlay ?? emptyOverlay()),
  };

  for (const op of input.operations) {
    if (!permitted.has(op.operation)) reject(`operation_not_permitted_this_cycle:${op.operation}`);
    state = applyOne(state, op, input.constraints);
  }

  const overlay = presentationOverlaySchema.parse(state.overlay);
  return {
    plan: state.plan,
    overlay,
    planHash: demoV2Hash(state.plan),
    overlayHash: demoV2Hash(overlay),
    appliedOperations: input.operations.length,
  };
}
