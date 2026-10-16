/**
 * The serve verb's nav bar, server side: the nav model the overlay renders
 * and the injection of the overlay's `<script>` into an HTML response.
 *
 * {@link buildNavModel} turns a `DiscoveryReport` and the project config's
 * `pages` into the page list the overlay shows: each of
 * `agentNotes.versionGroups` in its listed order, then every page in no
 * group, by path, each page marked kept or discarded. Only `pages.discard`
 * discards a page; a page in `pages.keep` or in neither list is kept.
 *
 * {@link injectNav} adds one classic `<script>` immediately before the last
 * `</body>` of an HTML body, matched case-insensitively, or at the end when
 * there is none. It works on the raw bytes, so every byte of the page
 * outside the inserted tag is served as it is on disk, whatever the page's
 * encoding. A request whose query holds `d2c-nav=0` gets no injection.
 *
 * @packageDocumentation
 */

import type { ProjectConfig } from '../../config/schema.ts';
import type { DiscoveryReport } from '../assess/schema.ts';

/** The query parameter that turns the nav bar off for one request. */
export const NAV_QUERY_PARAM = 'd2c-nav';

/** The {@link NAV_QUERY_PARAM} value that turns the nav bar off. */
export const NAV_OFF_VALUE = '0';

/** The attribute that marks the injected `<script>` as the nav bar's. */
export const NAV_SCRIPT_ATTRIBUTE = 'data-d2c-nav';

/** The closing tag the script goes before, lower case. */
const BODY_CLOSE = '</body>';

/** What would end the injected script early, lower case. */
const SCRIPT_CLOSE = '</script';

/** A page's saved curation choice. */
export type PageState = 'kept' | 'discarded';

/** One page as the nav bar lists it. */
export interface NavPage {
  /** The page path as `discovery.json` lists it, POSIX-relative to `source.dir`. */
  readonly path: string;
  /** The page's `<title>`, or null when it has none. */
  readonly title: string | null;
  /** Whether the page is kept or discarded. */
  readonly state: PageState;
}

/** One version group: pages that are versions of one page. */
export interface NavGroup {
  /** The group's discovered pages, in the order the group lists them. */
  readonly pages: readonly NavPage[];
}

/** The page list the nav bar renders. */
export interface NavModel {
  /** The version groups, in the order `agentNotes.versionGroups` lists them. */
  readonly groups: readonly NavGroup[];
  /** Every discovered page in no group, sorted by path. */
  readonly ungrouped: readonly NavPage[];
}

/** The config's `pages` field, as a parsed config carries it. */
export type PagesConfig = ProjectConfig['pages'];

/**
 * Builds the nav model from a discovery report and the config's `pages`.
 *
 * A group path that is not a discovered page is left out of its group, and
 * a group left with no page is dropped; a page listed by more than one
 * group appears in the first only. A page is `discarded` when
 * `pages.discard` lists it and `kept` otherwise, so a page in neither list
 * reads as kept.
 */
export function buildNavModel(report: DiscoveryReport, pages: PagesConfig): NavModel {
  const discarded = new Set(pages?.discard ?? []);
  const byPath = new Map(report.pages.map((page) => [page.path, page]));
  const placed = new Set<string>();

  const toNavPage = (path: string): NavPage => ({
    path,
    title: byPath.get(path)?.title ?? null,
    state: discarded.has(path)
      ? 'discarded'
      : 'kept',
  });

  const groups = report.agentNotes.versionGroups
    .map((group) => {
      const members = group.filter((path) => byPath.has(path) && !placed.has(path));

      members.forEach((path) => placed.add(path));

      return { pages: members.map(toNavPage) };
    })
    .filter((group) => group.pages.length > 0);

  const ungrouped = [...byPath.keys()]
    .filter((path) => !placed.has(path))
    .sort()
    .map(toNavPage);

  return { groups, ungrouped };
}

/** Returns the target's query, without its `?` or any fragment. */
function queryPart(rawTarget: string): string {
  const withoutFragment = rawTarget.split('#', 1)[0] ?? '';
  const start = withoutFragment.indexOf('?');

  return start === -1
    ? ''
    : withoutFragment.slice(start + 1);
}

/**
 * Whether the raw request target turns the nav bar off: its query holds
 * `d2c-nav=0` among any other parameters.
 */
export function isNavDisabled(rawTarget: string): boolean {
  return new URLSearchParams(queryPart(rawTarget)).getAll(NAV_QUERY_PARAM)
    .includes(NAV_OFF_VALUE);
}

/**
 * Wraps the overlay's browser source in the classic `<script>` tag that is
 * injected.
 *
 * @throws Error when the source holds `</script`, in any case, which would
 * end the tag early.
 */
export function navScriptTag(clientSource: string): string {
  if (clientSource.toLowerCase().includes(SCRIPT_CLOSE)) {
    throw new Error(`nav client source must not hold "${SCRIPT_CLOSE}": it would end the injected tag`);
  }

  return `<script ${NAV_SCRIPT_ATTRIBUTE}>${clientSource}</script>`;
}

/**
 * Injects the nav `<script>` into an HTML response body for the request
 * target `rawTarget` (`req.url` as the server reads it).
 *
 * Returns `body` itself when the target's query holds `d2c-nav=0`.
 * Otherwise returns a new buffer holding `body` with
 * {@link navScriptTag}`(clientSource)` inserted immediately before the last
 * `</body>`, matched case-insensitively, or appended at the end when the
 * body has none. `body` is never changed.
 *
 * @throws Error from {@link navScriptTag} when the client source cannot be
 * wrapped.
 */
export function injectNav(body: Buffer, rawTarget: string, clientSource: string): Buffer {
  if (isNavDisabled(rawTarget)) {
    return body;
  }

  const tag = Buffer.from(navScriptTag(clientSource), 'utf8');
  // latin1 maps each byte to one code unit, so a string index is a byte index.
  const at = body.toString('latin1').toLowerCase()
    .lastIndexOf(BODY_CLOSE);
  const splitAt = at === -1
    ? body.byteLength
    : at;

  return Buffer.concat([body.subarray(0, splitAt), tag, body.subarray(splitAt)]);
}
