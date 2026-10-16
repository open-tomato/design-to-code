/**
 * Page discovery: what each HTML page of an export loads and marks.
 *
 * A page is any file whose name ends in `.html` (`.dc.html` included), at
 * any depth. Each page is parsed with `parse5`, as a browser would parse
 * it, never matched with regular expressions, and read for:
 *
 * - `title` — the first HTML `<title>`'s text, whitespace stripped and
 *   collapsed as `document.title` does; null when the page has none.
 * - `scripts` — every HTML `<script>` in document order: `{ src, type }`
 *   when it names a source, `{ inline: true, type }` when it carries its
 *   own code. `type` is the attribute as written, or null.
 * - `stylesheets` — every `<link rel="stylesheet" href>` and `<style>` in
 *   document order.
 * - `markers` — a count per `data-*` attribute name over every element,
 *   keys sorted by code unit.
 *
 * Scripts and stylesheets keep document order, never sorted: the served
 * page breaks later if they load in another order. The inert content of a
 * `<template>` is not walked, since none of it loads with the page.
 *
 * @packageDocumentation
 */

import type { Page, PageScript, PageStylesheet } from './schema.ts';
import type { DefaultTreeAdapterTypes } from 'parse5';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { html, parse } from 'parse5';

import { comparePaths } from './walk.ts';

type Element = DefaultTreeAdapterTypes.Element;

type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/** The file-name ending, matched without regard to case, that makes a page. */
const PAGE_EXTENSION = '.html';

/** The prefix of the attribute names a page's `markers` count. */
const MARKER_PREFIX = 'data-';

/** The `rel` token that makes a `<link>` load a stylesheet. */
const STYLESHEET_REL = 'stylesheet';

/** ASCII whitespace as the HTML standard defines it. */
const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

/** True when `path` names an HTML page: its name ends in `.html`. */
export function isPagePath(path: string): boolean {
  return path.toLowerCase().endsWith(PAGE_EXTENSION);
}

function isElement(node: DefaultTreeAdapterTypes.ChildNode): node is Element {
  return 'tagName' in node;
}

/** Every element under `parent`, in document order (pre-order). */
function elementsOf(parent: ParentNode): readonly Element[] {
  return parent.childNodes
    .filter(isElement)
    .flatMap((element) => [element, ...elementsOf(element)]);
}

function isHtml(element: Element, tagName: string): boolean {
  return element.namespaceURI === html.NS.HTML && element.tagName === tagName;
}

function attributeOf(element: Element, name: string): string | null {
  return element.attrs.find((attribute) => attribute.name === name)?.value ?? null;
}

function textOf(element: Element): string {
  return element.childNodes
    .map((child) => ('value' in child
      ? child.value
      : ''))
    .join('');
}

function titleOf(elements: readonly Element[]): string | null {
  const title = elements.find((element) => isHtml(element, 'title'));

  if (title === undefined) {
    return null;
  }

  return textOf(title)
    .split(ASCII_WHITESPACE)
    .filter((word) => word !== '')
    .join(' ');
}

/**
 * A script by `src` or inline. A `src` attribute that is present but empty
 * loads nothing and runs nothing, as in a browser, so it is left out.
 */
function scriptOf(element: Element): readonly PageScript[] {
  const src = attributeOf(element, 'src');
  const type = attributeOf(element, 'type');

  if (src === null) {
    return [{ inline: true, type }];
  }

  return src === ''
    ? []
    : [{ src, type }];
}

function isStylesheetLink(element: Element): boolean {
  const rel = attributeOf(element, 'rel') ?? '';

  return rel
    .toLowerCase()
    .split(ASCII_WHITESPACE)
    .includes(STYLESHEET_REL);
}

/** A stylesheet link with an empty or missing `href` loads nothing. */
function stylesheetOf(element: Element): readonly PageStylesheet[] {
  if (isHtml(element, 'style')) {
    return [{ inline: true }];
  }

  const href = attributeOf(element, 'href') ?? '';

  return isHtml(element, 'link') && isStylesheetLink(element) && href !== ''
    ? [{ href }]
    : [];
}

function markersOf(elements: readonly Element[]): Record<string, number> {
  const names = elements
    .flatMap((element) => element.attrs.map((attribute) => attribute.name))
    .filter((name) => name.startsWith(MARKER_PREFIX) && name.length > MARKER_PREFIX.length);
  const counts = names.reduce(
    (tally, name) => new Map([...tally, [name, (tally.get(name) ?? 0) + 1]]),
    new Map<string, number>(),
  );

  return Object.fromEntries([...counts].sort(([left], [right]) => comparePaths(left, right)));
}

/**
 * Reads one page from its HTML text.
 *
 * @param path - The page's path, POSIX-relative to the source dir; stored
 * as given.
 * @param source - The page's HTML.
 */
export function parsePage(path: string, source: string): Page {
  const elements = elementsOf(parse(source));

  return {
    path,
    title: titleOf(elements),
    scripts: elements.filter((element) => isHtml(element, 'script')).flatMap(scriptOf),
    stylesheets: elements.flatMap(stylesheetOf),
    markers: markersOf(elements),
  };
}

/**
 * Reads every page among `paths`, the source dir's file list as
 * {@link walkSourceDir} gives it, sorted by path.
 *
 * @param sourceDir - The directory `paths` are relative to.
 * @param paths - POSIX paths relative to `sourceDir`; those that are not
 * pages ({@link isPagePath}) are ignored.
 */
export function discoverPages(sourceDir: string, paths: readonly string[]): Page[] {
  return paths
    .filter(isPagePath)
    .sort(comparePaths)
    .map((path) => parsePage(path, readFileSync(join(sourceDir, ...path.split('/')), 'utf8')));
}
