import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { discoverPages, isPagePath, parsePage } from './pages.ts';
import { walkSourceDir } from './walk.ts';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

/** The second script `with-ds/landing-v2.dc.html` loads. */
const REACT_URL = 'https://unpkg.com/react@18.3.1/umd/react.development.js';

/** Discovers the pages of one fixture export, as discovery walks it. */
function pagesOf(fixture: string) {
  const dir = join(FIXTURES_DIR, fixture);

  return discoverPages(dir, walkSourceDir(dir));
}

/** A minimal document with `head` and `body` markup. */
function page(head: string, body = ''): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe('isPagePath', () => {
  test('matches .html and .dc.html at any depth, in any case', () => {
    expect(isPagePath('index.html')).toBe(true);
    expect(isPagePath('landing.dc.html')).toBe(true);
    expect(isPagePath('screens/app/dashboard.html')).toBe(true);
    expect(isPagePath('LEGACY.HTML')).toBe(true);
  });

  test('rejects every other file', () => {
    expect(isPagePath('styles.css')).toBe(false);
    expect(isPagePath('page.htm')).toBe(false);
    expect(isPagePath('html/notes.txt')).toBe(false);
  });
});

describe('discoverPages on the with-ds fixture', () => {
  test('lists both versions of the .dc.html page, sorted by path', () => {
    expect(pagesOf('with-ds').map((entry) => entry.path)).toEqual(['landing-v2.dc.html', 'landing.dc.html']);
  });

  test('keeps the three scripts of landing-v2 in document order', () => {
    const landingV2 = pagesOf('with-ds').find((entry) => entry.path === 'landing-v2.dc.html');

    expect(landingV2?.scripts).toEqual([
      { src: 'support.js', type: null },
      { src: REACT_URL, type: null },
      { inline: true, type: 'text/babel' },
    ]);
  });

  test('reads the whole of landing-v2: title, stylesheets and markers', () => {
    const landingV2 = pagesOf('with-ds').find((entry) => entry.path === 'landing-v2.dc.html');

    expect(landingV2).toEqual({
      path: 'landing-v2.dc.html',
      title: 'Landing v2',
      scripts: [
        { src: 'support.js', type: null },
        { src: REACT_URL, type: null },
        { inline: true, type: 'text/babel' },
      ],
      stylesheets: [{ href: 'system/theme.css' }, { inline: true }],
      markers: { 'data-dc-component': 3, 'data-dc-screen': 1, 'data-dc-variant': 2 },
    });
  });

  test('reads the earlier landing version with its own two scripts', () => {
    const landing = pagesOf('with-ds').find((entry) => entry.path === 'landing.dc.html');

    expect(landing).toEqual({
      path: 'landing.dc.html',
      title: 'Landing',
      scripts: [{ src: 'support.js', type: null }, { inline: true, type: 'text/babel' }],
      stylesheets: [{ href: 'system/theme.css' }],
      markers: { 'data-dc-component': 2, 'data-dc-screen': 1, 'data-dc-variant': 1 },
    });
  });
});

describe('discoverPages on the nested fixture', () => {
  test('finds the pages two levels down when the root holds no HTML', () => {
    const pages = pagesOf('nested');

    expect(pages.map((entry) => [entry.path, entry.title])).toEqual([
      ['screens/app/dashboard.html', 'Dashboard'],
      ['screens/marketing/home.html', 'Marketing home'],
    ]);
  });

  test('keeps each nested page\'s stylesheet href as written and counts its markers', () => {
    const [dashboard, home] = pagesOf('nested');

    expect(dashboard?.stylesheets).toEqual([{ href: '../../shared/base.css' }]);
    expect(dashboard?.markers).toEqual({ 'data-screen': 1, 'data-widget': 2 });
    expect(home?.markers).toEqual({ 'data-screen': 1 });
  });
});

describe('discoverPages on the without-ds fixture', () => {
  test('reports a page with no <title> as null and no markers as empty', () => {
    const about = pagesOf('without-ds').find((entry) => entry.path === 'about.html');

    expect(about).toEqual({
      path: 'about.html',
      title: null,
      scripts: [],
      stylesheets: [{ href: 'palette.css' }, { href: 'styles.css' }],
      markers: {},
    });
  });

  test('ignores the export\'s non-page files', () => {
    expect(pagesOf('without-ds').map((entry) => entry.path)).toEqual(['about.html', 'index.html']);
  });

  test('reads a file from disk exactly as parsePage reads its text', () => {
    const dir = join(FIXTURES_DIR, 'without-ds');
    const index = pagesOf('without-ds').find((entry) => entry.path === 'index.html');

    expect(index).toEqual(parsePage('index.html', readFileSync(join(dir, 'index.html'), 'utf8')));
    expect(index?.scripts).toEqual([{ src: 'app.js', type: null }]);
  });
});

describe('parsePage scripts', () => {
  // Control for the three-script pin: landing-v2's scripts in the reverse
  // order must come back reversed. Any sort gives one order for both, so
  // the pin and this control cannot both pass unless order is the document's.
  test('follows document order, not a sort', () => {
    const reversed = parsePage('p.html', page(
      '<script type="text/babel">go()</script>'
      + `<script src="${REACT_URL}"></script>`
      + '<script src="support.js"></script>',
    ));

    expect(reversed.scripts).toEqual([
      { inline: true, type: 'text/babel' },
      { src: REACT_URL, type: null },
      { src: 'support.js', type: null },
    ]);
  });

  test('interleaves head and body scripts as the document orders them', () => {
    const parsed = parsePage('p.html', page('<script src="a.js"></script>', '<script>b()</script><script type="module" src="c.js"></script>'));

    expect(parsed.scripts).toEqual([
      { src: 'a.js', type: null },
      { inline: true, type: null },
      { src: 'c.js', type: 'module' },
    ]);
  });

  test('leaves out a script whose src is empty, since it loads and runs nothing', () => {
    expect(parsePage('p.html', page('<script src=""></script><script src="a.js"></script>')).scripts)
      .toEqual([{ src: 'a.js', type: null }]);
  });

  test('parses markup, so a script in a comment or in script text is not a script', () => {
    const parsed = parsePage('p.html', page(
      '<!-- <script src="commented.js"></script> -->',
      '<script>document.write(\'<script src="written.js"><\\/script>\')</script>',
    ));

    expect(parsed.scripts).toEqual([{ inline: true, type: null }]);
  });

  test('does not walk the inert content of a <template>', () => {
    const parsed = parsePage('p.html', page('', '<template><script src="t.js"></script><p data-kept="x"></p></template>'));

    expect(parsed.scripts).toEqual([]);
    expect(parsed.markers).toEqual({});
  });
});

describe('parsePage stylesheets', () => {
  test('interleaves links and <style> blocks in document order', () => {
    const parsed = parsePage('p.html', page(
      '<style>a{}</style><link rel="stylesheet" href="b.css"><link rel="icon" href="i.png">',
      '<style>c{}</style>',
    ));

    expect(parsed.stylesheets).toEqual([{ inline: true }, { href: 'b.css' }, { inline: true }]);
  });

  test('reads rel as a case-insensitive token list', () => {
    const parsed = parsePage('p.html', page('<link rel="alternate  STYLESHEET" href="alt.css"><link rel="stylesheets" href="no.css">'));

    expect(parsed.stylesheets).toEqual([{ href: 'alt.css' }]);
  });

  test('leaves out a stylesheet link with an empty or missing href', () => {
    const parsed = parsePage('p.html', page('<link rel="stylesheet" href=""><link rel="stylesheet">'));

    expect(parsed.stylesheets).toEqual([]);
  });
});

describe('parsePage title', () => {
  test('strips and collapses whitespace as document.title does', () => {
    expect(parsePage('p.html', page('<title>\n  Two \t words\n</title>')).title).toBe('Two words');
  });

  test('gives an empty string for an empty <title> and null for none', () => {
    expect(parsePage('p.html', page('<title></title>')).title).toBe('');
    expect(parsePage('p.html', page('')).title).toBeNull();
  });

  test('takes the first HTML <title>, never an SVG one', () => {
    const parsed = parsePage('p.html', page('', '<svg><title>Icon</title></svg><title>Late</title>'));

    expect(parsed.title).toBe('Late');
  });
});

describe('parsePage markers', () => {
  test('counts each data-* name over every element, keys sorted by code unit', () => {
    const parsed = parsePage('p.html', page('', '<div data-z="1" data-a><span data-z="2"></span></div><svg data-Icon="x"></svg>'));

    expect(parsed.markers).toEqual({ 'data-a': 1, 'data-icon': 1, 'data-z': 2 });
    expect(Object.keys(parsed.markers)).toEqual(['data-a', 'data-icon', 'data-z']);
  });

  test('ignores a bare data- attribute and names that only contain data-', () => {
    const parsed = parsePage('p.html', page('', '<div data- x-data-y="1" data="2"></div>'));

    expect(parsed.markers).toEqual({});
  });
});
