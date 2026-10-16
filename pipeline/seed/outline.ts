/**
 * The agent path's DOM outline: a compact, document-order list of the
 * visible elements of a loaded page's rendered DOM, which the seed prompt
 * hands the agent in place of the page's HTML.
 *
 * Each node is `{ depth, tag, id, classes, data, text }`:
 *
 * - `depth` — the element's depth below `body`, which is itself the first
 *   node at depth 0; its children are at depth 1, and so on. A skipped
 *   element does not change the depth of what is below it.
 * - `tag` — the lower-case tag name.
 * - `id` — the `id` attribute, or `null` when there is none.
 * - `classes` — the class list, in attribute order.
 * - `data` — every `data-*` attribute, by full attribute name, such as
 *   `{ "data-role": "nav" }`.
 * - `text` — the element's own text: its direct text-node children
 *   joined, whitespace runs collapsed to one space, trimmed, and cut to
 *   {@link TEXT_SAMPLE_LENGTH} characters (code points).
 *
 * Only `body` and what it holds is walked. A `script`, `style`,
 * `noscript` or `template` element ({@link SKIPPED_TAGS}) is skipped with
 * everything inside it. An element that is not visible — `display: none`
 * on it or an ancestor, `content-visibility: hidden` on an ancestor, or a
 * computed `visibility` other than `visible`, as Chromium's
 * `checkVisibility` reads them — is left out, but its children are still
 * walked, so a `visibility: visible` child of a `visibility: hidden`
 * parent is kept. Only the light DOM is read.
 *
 * The outline's `nodes` list, serialized with `JSON.stringify`, is at most
 * {@link OUTLINE_BYTE_BUDGET} UTF-8 bytes. The walk stops at the first
 * node that would carry the list past the budget and marks the outline
 * `truncated: true`; the nodes it holds are always a document-order prefix
 * of the full walk.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';

import { z } from 'zod';

import { relativePath } from '../assess/schema.ts';

/** The most characters of an element's own text an outline node keeps. */
export const TEXT_SAMPLE_LENGTH = 80;

/** The most UTF-8 bytes of one page's serialized outline `nodes` list: 48 KiB. */
export const OUTLINE_BYTE_BUDGET = 48 * 1024;

/** The tags skipped with their whole subtree. */
export const SKIPPED_TAGS = ['script', 'style', 'noscript', 'template'] as const;

/** Validates one outline node, per this module's documentation. */
export const outlineNodeSchema = z.strictObject({
  depth: z.int().nonnegative(),
  tag: z.string().min(1),
  id: z.string().nullable(),
  classes: z.array(z.string().min(1)).readonly(),
  data: z.record(z.string().startsWith('data-'), z.string()),
  text: z.string().refine((text) => [...text].length <= TEXT_SAMPLE_LENGTH, {
    error: `must be at most ${TEXT_SAMPLE_LENGTH} characters`,
  }),
});

/**
 * Validates one page's outline: the `page` path as `discovery.json` lists
 * it, its visible element `nodes` in document order, and whether the walk
 * was cut at {@link OUTLINE_BYTE_BUDGET}.
 */
export const domOutlineSchema = z.strictObject({
  page: relativePath,
  nodes: z.array(outlineNodeSchema).readonly(),
  truncated: z.boolean(),
});

/** One visible element of a page, as an outline lists it. */
export type OutlineNode = z.infer<typeof outlineNodeSchema>;

/** One page's DOM outline. */
export type DomOutline = z.infer<typeof domOutlineSchema>;

/** The in-page walk's argument. */
interface WalkArgs {
  readonly skippedTags: readonly string[];
  readonly textLength: number;
  readonly byteBudget: number;
}

/** What the in-page walk returns. */
interface WalkResult {
  readonly nodes: OutlineNode[];
  readonly truncated: boolean;
}

/**
 * Runs in the page: walks `body` in document order and collects the
 * outline nodes up to the byte budget. Self-contained, since Playwright
 * sends its source to the page.
 */
function walkOutlineInPage(args: WalkArgs): WalkResult {
  const { skippedTags, textLength, byteBudget } = args;
  const encoder = new TextEncoder();
  const nodes: OutlineNode[] = [];
  // The serialized list starts as `[]`; each node adds itself and, after
  // the first, one comma.
  let bytes = 2;
  let truncated = false;

  const ownText = (element: Element): string => {
    const joined = [...element.childNodes]
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => child.nodeValue ?? '')
      .join(' ');

    return [...joined.replace(/\s+/g, ' ').trim()].slice(0, textLength)
      .join('');
  };
  const nodeOf = (element: Element, depth: number): OutlineNode => ({
    depth,
    tag: element.tagName.toLowerCase(),
    id: element.getAttribute('id'),
    classes: [...element.classList],
    data: Object.fromEntries([...element.attributes]
      .filter((attribute) => attribute.name.startsWith('data-'))
      .map((attribute) => [attribute.name, attribute.value])),
    text: ownText(element),
  });
  const visit = (element: Element, depth: number): void => {
    if (truncated || skippedTags.includes(element.tagName.toLowerCase())) {
      return;
    }

    if (element.checkVisibility({ visibilityProperty: true })) {
      const node = nodeOf(element, depth);
      const size = encoder.encode(JSON.stringify(node)).length + (nodes.length > 0
        ? 1
        : 0);

      if (bytes + size > byteBudget) {
        truncated = true;

        return;
      }

      bytes += size;
      nodes.push(node);
    }

    [...element.children].forEach((child) => {
      visit(child, depth + 1);
    });
  };

  visit(document.body, 0);

  return { nodes, truncated };
}

/**
 * Reads the DOM outline of the rendered DOM of `page`, per this module's
 * documentation: visible elements only, cut to {@link OUTLINE_BYTE_BUDGET}
 * with `truncated: true`.
 *
 * @param page - A page loaded by `withSeedPage`.
 * @param pagePath - The page's path as `discovery.json` lists it, written
 * into the outline's `page`.
 * @returns The page's outline, checked against {@link domOutlineSchema}.
 * @throws ZodError when the walk's result fails the schema, such as a
 * `pagePath` that is not source-dir relative.
 */
export async function readDomOutline(page: Page, pagePath: string): Promise<DomOutline> {
  const walked = await page.evaluate(walkOutlineInPage, {
    skippedTags: SKIPPED_TAGS,
    textLength: TEXT_SAMPLE_LENGTH,
    byteBudget: OUTLINE_BYTE_BUDGET,
  });

  return domOutlineSchema.parse({ page: pagePath, ...walked });
}
