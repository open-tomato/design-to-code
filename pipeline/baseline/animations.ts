/**
 * The animation inventory: what `document.getAnimations()` reports for a
 * loaded page, recorded as data in `<key dir>/animations.json` so motion
 * is compared by its own gate rather than read out of pixels.
 *
 * {@link readAnimationInventory} runs in a page already loaded by
 * `withLoadedPage` and lists, for each running animation, in the order the
 * document returns them: its kind (`CSSAnimation` with its
 * `animationName`, `CSSTransition` with its `transitionProperty`, or
 * `other`, such as one started by `element.animate`), the target's CSS
 * selector path, the effect's `getTiming()` (duration, delay, easing,
 * iterations, direction, fill) and its `getKeyframes()`.
 *
 * Values are recorded as Chromium reports them, with two changes JSON
 * forces or order asks for: an infinite duration or iteration count is the
 * string {@link INFINITE}, and each keyframe's animated properties sit
 * under `properties`, sorted by name. A CSS animation's
 * `animation-timing-function` is applied per keyframe, so Chromium reports
 * it on every keyframe's `easing` while the timing's own `easing` stays
 * `linear`; a transition's timing function is the timing's `easing`.
 *
 * The selector path runs from `html` down to the target, one
 * `>`-separated step per element: the tag name, then `#id` when the
 * element has one, else `:nth-of-type(n)` when a sibling shares its tag.
 * A pseudo-element target appends its `::name`. The path follows parent
 * elements only, so a target inside a shadow root is named from the
 * shadow root's top element down.
 *
 * {@link writeAnimations} validates the per-page inventories against
 * {@link animationsFileSchema}, sorts them by page and writes them through
 * a temporary file renamed over `animations.json`, after checking that
 * path resolves inside the key directory.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';

import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { z } from 'zod';

import { BaselinePathError } from './key.ts';

/** The inventory's file name, directly under the key directory. */
export const ANIMATIONS_FILE = 'animations.json';

/** What an infinite duration or iteration count is recorded as, since JSON has no `Infinity`. */
export const INFINITE = 'infinite';

/** Random bytes in the temporary file's name, so two writers never share one. */
const TEMP_NAME_BYTES = 6;

/** A duration or iteration count: a non-negative number, {@link INFINITE}, or a keyword such as `auto`. */
const countField = z.union([z.number().nonnegative(), z.string().min(1)]);

/** `effect.getTiming()`, narrowed to the fields the inventory keeps. */
export const animationTimingSchema = z.strictObject({
  duration: countField,
  delay: z.number(),
  easing: z.string().min(1),
  iterations: countField,
  direction: z.enum(['normal', 'reverse', 'alternate', 'alternate-reverse']),
  fill: z.enum(['none', 'forwards', 'backwards', 'both', 'auto']),
});

/** One entry of `effect.getKeyframes()`, its animated properties under `properties`. */
export const animationKeyframeSchema = z.strictObject({
  offset: z.number().min(0)
    .max(1)
    .nullable(),
  computedOffset: z.number().min(0)
    .max(1),
  easing: z.string().min(1),
  composite: z.enum(['replace', 'add', 'accumulate', 'auto']),
  properties: z.record(z.string().min(1), z.string()),
});

/** The fields every inventory entry carries, whatever its kind. */
const commonFields = {
  target: z.string().min(1)
    .nullable(),
  timing: animationTimingSchema,
  keyframes: z.array(animationKeyframeSchema),
};

/** One animation of a page, discriminated by `kind`. */
export const animationEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('CSSAnimation'), animationName: z.string(), ...commonFields }),
  z.strictObject({ kind: z.literal('CSSTransition'), transitionProperty: z.string(), ...commonFields }),
  z.strictObject({ kind: z.literal('other'), ...commonFields }),
]);

/** One page's inventory: the page path, the viewport it was read at, and its animations. */
export const pageAnimationsSchema = z.strictObject({
  page: z.string().min(1),
  viewport: z.string().min(1),
  animations: z.array(animationEntrySchema).readonly(),
});

/** Validates `animations.json`: one inventory per page, no page listed twice. */
export const animationsFileSchema = z.array(pageAnimationsSchema).superRefine((pages, context) => {
  const seen = new Set<string>();

  pages.forEach((entry, index) => {
    if (seen.has(entry.page)) {
      context.addIssue({ code: 'custom', path: [index, 'page'], message: `page "${entry.page}" is listed twice` });
    }

    seen.add(entry.page);
  });
});

/** One animation as recorded. */
export type AnimationEntry = z.infer<typeof animationEntrySchema>;

/** One page's recorded inventory. */
export type PageAnimations = z.infer<typeof pageAnimationsSchema>;

/** An inventory that failed its schema, read from a page or about to be written. */
export class AnimationsError extends Error {
  override readonly name = 'AnimationsError';
}

/** Lists each failing field of a zod error, one indented line apiece. */
function issueLines(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Runs in the page: reads `document.getAnimations()` into plain entries.
 * Self-contained, since Playwright sends its source to the page; the
 * {@link INFINITE} marker arrives as `infinite`.
 */
function readAnimationsInPage(infinite: string): unknown[] {
  const reserved = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const count = (value: unknown): unknown => (value === Number.POSITIVE_INFINITY
    ? infinite
    : value);
  const step = (element: Element): string => {
    const tag = element.localName;

    if (element.id !== '') {
      return `${tag}#${CSS.escape(element.id)}`;
    }

    const siblings = element.parentElement === null
      ? []
      : [...element.parentElement.children].filter((sibling) => sibling.localName === tag);

    return siblings.length > 1
      ? `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
      : tag;
  };
  const selectorPath = (element: Element | null, pseudo: string | null): string | null => {
    if (element === null) {
      return null;
    }

    const steps: string[] = [];

    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      steps.unshift(step(current));
    }

    return `${steps.join(' > ')}${pseudo ?? ''}`;
  };

  return document.getAnimations().map((animation) => {
    const effect = animation.effect instanceof KeyframeEffect
      ? animation.effect
      : null;
    const timing = animation.effect?.getTiming() ?? {};
    const common = {
      target: selectorPath(effect?.target ?? null, effect?.pseudoElement ?? null),
      timing: {
        duration: count(timing.duration),
        delay: timing.delay,
        easing: timing.easing,
        iterations: count(timing.iterations),
        direction: timing.direction,
        fill: timing.fill,
      },
      keyframes: (effect?.getKeyframes() ?? []).map((keyframe) => ({
        offset: keyframe.offset,
        computedOffset: keyframe.computedOffset,
        easing: keyframe.easing,
        composite: keyframe.composite,
        properties: Object.fromEntries(Object.keys(keyframe)
          .filter((name) => !reserved.has(name))
          .sort()
          .map((name) => [name, String(keyframe[name])])),
      })),
    };

    if (animation instanceof CSSAnimation) {
      return { kind: 'CSSAnimation', animationName: animation.animationName, ...common };
    }

    return animation instanceof CSSTransition
      ? { kind: 'CSSTransition', transitionProperty: animation.transitionProperty, ...common }
      : { kind: 'other', ...common };
  });
}

/**
 * Reads the animations running in `page`, which `withLoadedPage` has
 * already loaded and settled.
 *
 * @param page - The loaded page.
 * @returns One entry per `document.getAnimations()` result, in its order.
 * @throws AnimationsError, naming the page's URL and each failing field,
 * when an entry does not fit {@link animationEntrySchema}.
 */
export async function readAnimationInventory(page: Page): Promise<readonly AnimationEntry[]> {
  const raw = await page.evaluate(readAnimationsInPage, INFINITE);
  const result = z.array(animationEntrySchema).safeParse(raw);

  if (!result.success) {
    throw new AnimationsError(`${page.url()}: unexpected animation inventory\n${issueLines(result.error)}`);
  }

  return result.data;
}

/**
 * `<keyDir>/animations.json`, resolved and checked to lie directly inside
 * `keyDir`.
 *
 * @throws BaselinePathError when the resolved path is not inside `keyDir`.
 */
export function animationsPath(keyDir: string): string {
  const root = resolve(keyDir);
  const target = resolve(root, ANIMATIONS_FILE);
  const fromRoot = relative(root, target);

  if (isAbsolute(fromRoot) || fromRoot !== ANIMATIONS_FILE) {
    throw new BaselinePathError(`${ANIMATIONS_FILE} does not resolve inside ${root}`);
  }

  return target;
}

/** Orders inventories by page, code unit by code unit, independent of locale. */
function byPage(left: PageAnimations, right: PageAnimations): number {
  if (left.page === right.page) {
    return 0;
  }

  return left.page < right.page
    ? -1
    : 1;
}

/**
 * Writes `pages` to `<keyDir>/animations.json`, sorted by page, as 2-space
 * JSON with a trailing newline, through a temporary file beside it renamed
 * over it. Creates the key directory when it is missing.
 *
 * @param keyDir - The key directory, from `keyDirectory`.
 * @param pages - One inventory per captured page.
 * @returns The inventories as written.
 * @throws AnimationsError when `pages` fails {@link animationsFileSchema},
 * a page listed twice included; nothing is written then.
 * @throws BaselinePathError when the file would land outside `keyDir`.
 */
export function writeAnimations(keyDir: string, pages: readonly PageAnimations[]): readonly PageAnimations[] {
  const target = animationsPath(keyDir);
  const result = animationsFileSchema.safeParse(pages);

  if (!result.success) {
    throw new AnimationsError(`${target}: invalid animation inventory\n${issueLines(result.error)}`);
  }

  const sorted = [...result.data].sort(byPage);
  const tempPath = `${target}.${process.pid}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}.tmp`;

  mkdirSync(keyDir, { recursive: true });

  try {
    writeFileSync(tempPath, `${JSON.stringify(sorted, null, 2)}\n`);
    renameSync(tempPath, target);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }

  return sorted;
}
