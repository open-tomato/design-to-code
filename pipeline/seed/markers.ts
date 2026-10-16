/**
 * The script path's marker reader: component candidates read from the
 * `data-*` markers of a loaded page's rendered DOM, so markers an export
 * adds from script are read as well as those in its static HTML.
 *
 * The marker convention:
 *
 * - `data-component="<Name>"` ({@link COMPONENT_ATTRIBUTE}) marks a
 *   component root.
 * - `data-level="<level>"` ({@link LEVEL_ATTRIBUTE}) on a root gives its
 *   level, one of `LEVELS`.
 * - `data-part="<part>"` ({@link PART_ATTRIBUTE}) marks a part of the
 *   nearest component root enclosing it. On an element that is itself a
 *   root, the part belongs to the root enclosing that one.
 * - `data-state="<state>"` ({@link STATE_ATTRIBUTE}) on a root marks that
 *   root as the static example of a state.
 * - `data-variant-<axis>="<value>"` ({@link VARIANT_ATTRIBUTE_PREFIX}) on a
 *   root gives one value of a variant axis.
 * - `data-doc="<Name>"` ({@link DOC_ATTRIBUTE}) marks an element whose
 *   trimmed text is one paragraph of doc text for that component.
 *
 * Roots sharing a name on the page make one candidate. The first of them
 * in document order without `data-state` is its `selector`, the other
 * stateless ones are its `examples`, and each `data-state` root is a
 * `mode: 'example'` state. When every root of a name carries `data-state`,
 * the first is the `selector` too. The candidate's level is its
 * `selector` root's; `variantAxes` and `parts` are gathered from all its
 * roots, sorted and unique; `docText` lists the non-empty trimmed text of
 * each `data-doc` element naming it, in document order. Candidates come in
 * the order their names first appear in the document.
 *
 * Selectors are built in the page by the builder `installUniqueSelector`
 * defines, so each names exactly one element of the page. Only the light
 * DOM is read: an element inside a shadow root is not seen.
 *
 * @packageDocumentation
 */

import type { UniqueSelector } from './page.ts';
import type { ComponentEntry, Level, RejectedCandidate } from './schema.ts';
import type { Page } from 'playwright';

import { z } from 'zod';

import { installUniqueSelector, UNIQUE_SELECTOR_GLOBAL } from './page.ts';
import { componentEntrySchema, LEVELS } from './schema.ts';

/** Marks a component root; its value is the component name. */
export const COMPONENT_ATTRIBUTE = 'data-component';

/** On a root, the component's level. */
export const LEVEL_ATTRIBUTE = 'data-level';

/** Marks a part of the nearest enclosing component root; its value is the part name. */
export const PART_ATTRIBUTE = 'data-part';

/** On a root, marks it as the static example of the named state. */
export const STATE_ATTRIBUTE = 'data-state';

/** The prefix of `data-variant-<axis>`, which on a root gives one value of `<axis>`. */
export const VARIANT_ATTRIBUTE_PREFIX = 'data-variant-';

/** Marks an element whose trimmed text is doc text for the named component. */
export const DOC_ATTRIBUTE = 'data-doc';

/** The marker attribute names, as the in-page reader takes them. */
export interface MarkerAttributes {
  readonly component: string;
  readonly level: string;
  readonly part: string;
  readonly state: string;
  readonly variantPrefix: string;
  readonly doc: string;
}

/** The marker convention's attribute names. */
export const MARKER_ATTRIBUTES: MarkerAttributes = {
  component: COMPONENT_ATTRIBUTE,
  level: LEVEL_ATTRIBUTE,
  part: PART_ATTRIBUTE,
  state: STATE_ATTRIBUTE,
  variantPrefix: VARIANT_ATTRIBUTE_PREFIX,
  doc: DOC_ATTRIBUTE,
};

/** What the marker read of one page found. */
export interface MarkedComponents {
  /** Candidates with a valid level and shape, `origin: 'markers'` stamped. */
  readonly candidates: readonly ComponentEntry[];
  /**
   * Candidates refused as read: `missing-level` when the `selector` root
   * has no `data-level` or one outside `LEVELS`, `invalid-shape` when the
   * read fails the entry schema (an empty name, state or variant value).
   */
  readonly rejected: readonly RejectedCandidate[];
}

/** One component as the in-page reader returns it, before its level is checked. */
interface RawMarkedComponent {
  readonly name: string;
  readonly level: string | null;
  readonly selector: string;
  readonly examples: string[];
  readonly states: { readonly name: string; readonly mode: 'example'; readonly selector: string }[];
  readonly variantAxes: Record<string, string[]>;
  readonly parts: string[];
  readonly docText: string[];
}

/** The in-page reader's argument. */
interface ReaderArgs {
  readonly attributes: MarkerAttributes;
  readonly builder: string;
}

/**
 * Runs in the page: groups the component roots by name and reads each
 * group per the marker convention. Self-contained, since Playwright sends
 * its source to the page; it calls the unique-selector global by name.
 */
function readMarkersInPage(args: ReaderArgs): RawMarkedComponent[] {
  const { attributes, builder } = args;
  const build = (window as unknown as Partial<Record<string, UniqueSelector>>)[builder];

  if (typeof build !== 'function') {
    throw new Error(`the ${builder} global is not installed on the page`);
  }

  const rootQuery = `[${attributes.component}]`;
  const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();
  const groups = new Map<string, Element[]>();

  document.querySelectorAll(rootQuery).forEach((root) => {
    const name = root.getAttribute(attributes.component) ?? '';

    groups.set(name, [...groups.get(name) ?? [], root]);
  });

  const partElements = [...document.querySelectorAll(`[${attributes.part}]`)];
  const docElements = [...document.querySelectorAll(`[${attributes.doc}]`)];
  const ownerOf = (element: Element): Element | null => (element.hasAttribute(attributes.component)
    ? element.parentElement
    : element)?.closest(rootQuery) ?? null;
  const variantAxesOf = (roots: readonly Element[]): Record<string, string[]> => {
    const axes = new Map<string, string[]>();

    roots.forEach((root) => {
      [...root.attributes]
        .filter((attribute) => attribute.name.startsWith(attributes.variantPrefix)
          && attribute.name.length > attributes.variantPrefix.length)
        .forEach((attribute) => {
          const axis = attribute.name.slice(attributes.variantPrefix.length);

          axes.set(axis, [...axes.get(axis) ?? [], attribute.value]);
        });
    });

    return Object.fromEntries([...axes.keys()].sort()
      .map((axis) => [axis, sortedUnique(axes.get(axis) ?? [])]));
  };

  // Every group holds at least one root; the guard only narrows the type.
  return [...groups].flatMap(([name, roots]) => {
    const stateless = roots.filter((root) => !root.hasAttribute(attributes.state));
    const primary = stateless[0] ?? roots[0];

    if (primary === undefined) {
      return [];
    }

    return [{
      name,
      level: primary.getAttribute(attributes.level),
      selector: build(primary),
      examples: stateless.slice(1).map(build),
      states: roots
        .filter((root) => root.hasAttribute(attributes.state))
        .map((root) => ({ name: root.getAttribute(attributes.state) ?? '', mode: 'example' as const, selector: build(root) })),
      variantAxes: variantAxesOf(roots),
      parts: sortedUnique(partElements
        .filter((part) => roots.some((root) => root === ownerOf(part)))
        .map((part) => part.getAttribute(attributes.part) ?? '')),
      docText: docElements
        .filter((element) => element.getAttribute(attributes.doc) === name)
        .map((element) => (element.textContent ?? '').trim())
        .filter((text) => text !== ''),
    }];
  });
}

/** True when `value` is one of {@link LEVELS}. */
function isLevel(value: string | null): value is Level {
  return LEVELS.some((level) => level === value);
}

/** Why `raw`'s level is refused, for its `missing-level` reason. */
function missingLevelDetail(raw: RawMarkedComponent, pagePath: string): string {
  const where = `the "${raw.name}" root ${raw.selector} on ${pagePath}`;

  return raw.level === null
    ? `${where} has no ${LEVEL_ATTRIBUTE}`
    : `${where} has ${LEVEL_ATTRIBUTE}="${raw.level}", not one of ${LEVELS.join(', ')}`;
}

/** Checks one read component: a candidate, or a rejection with its reason. */
function judge(raw: RawMarkedComponent, pagePath: string): ComponentEntry | RejectedCandidate {
  const proposal = {
    name: raw.name,
    ...raw.level === null
      ? {}
      : { level: raw.level },
    page: pagePath,
    selector: raw.selector,
    examples: raw.examples,
    states: raw.states,
    variantAxes: raw.variantAxes,
    parts: raw.parts,
    docText: raw.docText,
    origin: 'markers' as const,
  };

  if (!isLevel(raw.level)) {
    return { candidate: proposal, reasons: [{ code: 'missing-level', detail: missingLevelDetail(raw, pagePath) }] };
  }

  const parsed = componentEntrySchema.safeParse(proposal);

  return parsed.success
    ? parsed.data
    : { candidate: proposal, reasons: [{ code: 'invalid-shape', detail: z.prettifyError(parsed.error) }] };
}

/** True when `result` is a rejection rather than a candidate. */
function isRejection(result: ComponentEntry | RejectedCandidate): result is RejectedCandidate {
  return 'reasons' in result;
}

/**
 * Reads the component markers of the rendered DOM of `page`, per the
 * marker convention in this module's documentation, installing the
 * unique-selector builder first.
 *
 * @param page - A page loaded by `withSeedPage`.
 * @param pagePath - The page's path as `discovery.json` lists it, written
 * into each candidate's `page`.
 * @returns The candidates, `origin: 'markers'` stamped, and the rejections,
 * each in the order its name first appears in the document.
 */
export async function readMarkedComponents(page: Page, pagePath: string): Promise<MarkedComponents> {
  await installUniqueSelector(page);

  const raws = await page.evaluate(readMarkersInPage, { attributes: MARKER_ATTRIBUTES, builder: UNIQUE_SELECTOR_GLOBAL });
  const results = raws.map((raw) => judge(raw, pagePath));

  return {
    candidates: results.filter((result): result is ComponentEntry => !isRejection(result)),
    rejected: results.filter(isRejection),
  };
}

/**
 * Whether the rendered DOM of `page` holds at least one
 * {@link COMPONENT_ATTRIBUTE} element: a page that does takes the script
 * path only, one that does not goes to the agent path.
 *
 * @param page - A page loaded by `withSeedPage`.
 */
export function hasComponentMarkers(page: Page): Promise<boolean> {
  return page.evaluate((attribute) => document.querySelector(`[${attribute}]`) !== null, COMPONENT_ATTRIBUTE);
}
