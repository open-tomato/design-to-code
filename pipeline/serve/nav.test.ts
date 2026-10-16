import type { DiscoveryReport } from '../assess/schema.ts';

import { describe, expect, test } from 'vitest';

import { discoveryReportSchema, KNOWN_FILE_NAMES } from '../assess/schema.ts';

import {
  buildNavModel,
  injectNav,
  isNavDisabled,
  navScriptTag,
} from './nav.ts';

const CLIENT = '(() => { /* nav */ })();';

const TAG = navScriptTag(CLIENT);

const V1 = 'Rafa Portal.dc.html';
const V2 = 'Rafa Portal v2.dc.html';
const DASHBOARD = 'screens/app/dashboard.html';
const ABOUT = 'about.html';

/** A schema-valid report over `paths`, with `versionGroups` as given. */
function reportOf(paths: readonly string[], versionGroups: string[][] = []): DiscoveryReport {
  return discoveryReportSchema.parse({
    generatedAt: '2026-09-30T12:00:00.000Z',
    pages: [...paths].sort().map((path) => ({
      path,
      title: `Title of ${path}`,
      scripts: [],
      stylesheets: [],
      markers: {},
    })),
    tokens: [],
    variantMaps: [],
    assets: { images: [], fonts: [], styles: [], scripts: [], other: [] },
    knownFiles: KNOWN_FILE_NAMES.map((name) => ({ name, status: 'absent', paths: [] })),
    agentNotes: { pageRoles: {}, versionGroups, boundaryHints: [] },
  });
}

function paths(pages: readonly { path: string }[]): string[] {
  return pages.map((page) => page.path);
}

describe('buildNavModel', () => {
  test('lists each version group in its listed order, then ungrouped pages by path', () => {
    const report = reportOf([ABOUT, DASHBOARD, V1, V2], [[V2, V1]]);

    const model = buildNavModel(report, undefined);

    expect(model.groups.map((group) => paths(group.pages))).toEqual([[V2, V1]]);
    expect(paths(model.ungrouped)).toEqual([ABOUT, DASHBOARD]);
  });

  test('keeps the groups in the order the report lists them', () => {
    const report = reportOf([ABOUT, DASHBOARD, V1, V2], [[DASHBOARD, ABOUT], [V1, V2]]);

    const model = buildNavModel(report, undefined);

    expect(model.groups.map((group) => paths(group.pages))).toEqual([[DASHBOARD, ABOUT], [V1, V2]]);
    expect(model.ungrouped).toEqual([]);
  });

  test('carries each page title', () => {
    const model = buildNavModel(reportOf([ABOUT]), undefined);

    expect(model.ungrouped).toEqual([{ path: ABOUT, title: `Title of ${ABOUT}`, state: 'kept' }]);
  });

  test('leaves out group paths that are not discovered pages and drops an emptied group', () => {
    const report = reportOf([ABOUT, V1], [[V1, 'gone.html'], ['missing-a.html', 'missing-b.html']]);

    const model = buildNavModel(report, undefined);

    expect(model.groups.map((group) => paths(group.pages))).toEqual([[V1]]);
    expect(paths(model.ungrouped)).toEqual([ABOUT]);
  });

  test('places a page listed by two groups in the first only', () => {
    const report = reportOf([ABOUT, V1, V2], [[V1, V2], [V2, ABOUT]]);

    const model = buildNavModel(report, undefined);

    expect(model.groups.map((group) => paths(group.pages))).toEqual([[V1, V2], [ABOUT]]);
  });

  test('marks a discarded page discarded and a kept page kept', () => {
    const report = reportOf([ABOUT, DASHBOARD]);

    const model = buildNavModel(report, { keep: [ABOUT], discard: [DASHBOARD] });

    expect(model.ungrouped.map((page) => [page.path, page.state])).toEqual([
      [ABOUT, 'kept'],
      [DASHBOARD, 'discarded'],
    ]);
  });

  test('reads a page in neither list as kept', () => {
    const report = reportOf([ABOUT, DASHBOARD, V1], [[V1, DASHBOARD]]);

    const model = buildNavModel(report, { keep: [ABOUT], discard: [] });

    expect(model.groups[0]?.pages.map((page) => page.state)).toEqual(['kept', 'kept']);
    expect(model.ungrouped[0]?.state).toBe('kept');
  });

  test('reads every page as kept when the config has no pages field', () => {
    const model = buildNavModel(reportOf([ABOUT, V1]), undefined);

    expect(model.ungrouped.map((page) => page.state)).toEqual(['kept', 'kept']);
  });

  test('marks a discarded page discarded inside a group', () => {
    const report = reportOf([V1, V2], [[V1, V2]]);

    const model = buildNavModel(report, { discard: [V1] });

    expect(model.groups[0]?.pages.map((page) => page.state)).toEqual(['discarded', 'kept']);
  });
});

describe('isNavDisabled', () => {
  test.each([
    ['/page.html?d2c-nav=0', true],
    ['/page.html?v=2&d2c-nav=0', true],
    ['/page.html?d2c-nav=0#top', true],
    ['/page.html', false],
    ['/page.html?d2c-nav=1', false],
    ['/page.html?d2c-nav=00', false],
    ['/page.html#?d2c-nav=0', false],
    ['/d2c-nav=0.html', false],
  ])('reads %s as %s', (target, expected) => {
    expect(isNavDisabled(target)).toBe(expected);
  });
});

describe('injectNav', () => {
  test('inserts the script immediately before </body>', () => {
    const body = Buffer.from('<html><body><p>hi</p></body></html>\n');

    const result = injectNav(body, '/page.html', CLIENT);

    expect(result.toString()).toBe(`<html><body><p>hi</p>${TAG}</body></html>\n`);
  });

  test('skips injection when the query holds d2c-nav=0', () => {
    const body = Buffer.from('<html><body></body></html>');

    const result = injectNav(body, '/page.html?d2c-nav=0', CLIENT);

    expect(result.equals(body)).toBe(true);
    expect(result.toString()).not.toContain('<script');
  });

  test('injects when d2c-nav holds another value (control for the skip)', () => {
    const body = Buffer.from('<html><body></body></html>');

    expect(injectNav(body, '/page.html?d2c-nav=1', CLIENT).toString()).toContain(TAG);
  });

  test('matches an upper-case </BODY>', () => {
    const body = Buffer.from('<HTML><BODY>x</BODY></HTML>');

    expect(injectNav(body, '/', CLIENT).toString()).toBe(`<HTML><BODY>x${TAG}</BODY></HTML>`);
  });

  test('matches a mixed-case </Body>', () => {
    const body = Buffer.from('<body>x</Body>');

    expect(injectNav(body, '/', CLIENT).toString()).toBe(`<body>x${TAG}</Body>`);
  });

  test('appends the script at the end of a page with no </body>', () => {
    const body = Buffer.from('<p>fragment</p>\n');

    expect(injectNav(body, '/', CLIENT).toString()).toBe(`<p>fragment</p>\n${TAG}`);
  });

  test('uses the last </body> when a script string holds an earlier one', () => {
    const body = Buffer.from('<body><script>const s = "</body>";</script>y</body>');

    expect(injectNav(body, '/', CLIENT).toString())
      .toBe(`<body><script>const s = "</body>";</script>y${TAG}</body>`);
  });

  test('keeps every byte outside the tag, including bytes that are not UTF-8', () => {
    const before = Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0xff, 0xc0, 0x80]);
    const after = Buffer.from('</body>');
    const body = Buffer.concat([before, after]);

    const result = injectNav(body, '/', CLIENT);

    expect(result.equals(Buffer.concat([before, Buffer.from(TAG), after]))).toBe(true);
  });

  test('leaves the input buffer unchanged', () => {
    const body = Buffer.from('<body></body>');
    const copy = Buffer.from(body);

    injectNav(body, '/', CLIENT);

    expect(body.equals(copy)).toBe(true);
  });
});

describe('navScriptTag', () => {
  test('wraps the source in one classic script tag', () => {
    expect(navScriptTag(CLIENT)).toBe(`<script data-d2c-nav>${CLIENT}</script>`);
  });

  test.each(['"</script>"', '"</SCRIPT >"'])('refuses a source holding %s', (source) => {
    expect(() => navScriptTag(source)).toThrow('must not hold');
  });
});
