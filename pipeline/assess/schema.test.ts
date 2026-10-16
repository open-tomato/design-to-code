import type { DiscoveryReport, ScriptReport } from './schema.ts';

import { describe, expect, test } from 'vitest';

import {
  agentNotesSchema,
  discoveryReportSchema,
  emptyAgentNotes,
  KNOWN_FILE_NAMES,
  SCRIPT_FIELDS,
  scriptReportSchema,
} from './schema.ts';

const GENERATED_AT = '2026-09-30T12:00:00.000Z';

const SCRIPT_REPORT: ScriptReport = {
  generatedAt: GENERATED_AT,
  pages: [
    {
      path: 'landing-v2.dc.html',
      title: 'Landing v2',
      // Document order, deliberately not alphabetical.
      scripts: [
        { src: 'support.js', type: null },
        { src: 'https://unpkg.com/react@19/umd/react.js', type: null },
        { inline: true, type: 'text/babel' },
      ],
      stylesheets: [{ href: 'system/theme.css' }, { inline: true }],
      markers: { 'data-dc-component': 3, 'data-dc-screen': 1 },
    },
    {
      path: 'screens/app/dashboard.html',
      title: null,
      scripts: [],
      stylesheets: [],
      markers: {},
    },
  ],
  tokens: [{ path: 'system/theme.css', customPropertyCount: 4 }, { path: 'system/tokens.ts', customPropertyCount: 0 }],
  variantMaps: [{ path: 'system/variants.ts' }],
  assets: {
    images: ['logo.svg'],
    fonts: [],
    styles: ['system/theme.css'],
    scripts: ['support.js'],
    other: ['_ds/ds_1/_ds_manifest.json'],
  },
  knownFiles: KNOWN_FILE_NAMES.map((name) => (name === 'support.js'
    ? { name, status: 'found' as const, paths: ['support.js'] }
    : { name, status: 'absent' as const, paths: [] })),
};

const REPORT: DiscoveryReport = {
  ...SCRIPT_REPORT,
  agentNotes: {
    pageRoles: { 'landing-v2.dc.html': { role: 'demo', reason: 'shows every variant' } },
    versionGroups: [['landing-v2.dc.html', 'landing.dc.html']],
    boundaryHints: [
      { page: 'landing-v2.dc.html', marker: 'data-dc-component', note: 'one per component' },
      { page: 'landing-v2.dc.html', selector: 'main > section', note: 'hero block' },
    ],
  },
};

/** The dotted paths of every issue a failed parse of the report reports, sorted. */
function failingPaths(input: unknown): string[] {
  const result = discoveryReportSchema.safeParse(input);

  if (result.success) {
    throw new Error(`expected ${JSON.stringify(input)} to fail`);
  }

  return result.error.issues.map((issue) => issue.path.join('.')).sort();
}

/** The report with its first page replaced by `page`'s fields over the original. */
function withFirstPage(page: Record<string, unknown>): unknown {
  const [first, ...rest] = REPORT.pages;

  return { ...REPORT, pages: [{ ...first, ...page }, ...rest] };
}

describe('discoveryReportSchema', () => {
  test('accepts a full report unchanged', () => {
    expect(discoveryReportSchema.parse(REPORT)).toStrictEqual(REPORT);
  });

  test('keeps script and stylesheet document order', () => {
    const parsed = discoveryReportSchema.parse(REPORT);

    expect(parsed.pages[0]?.scripts.map((script) => ('src' in script
      ? script.src
      : 'inline'))).toStrictEqual(['support.js', 'https://unpkg.com/react@19/umd/react.js', 'inline']);
    expect(parsed.pages[0]?.stylesheets).toStrictEqual([{ href: 'system/theme.css' }, { inline: true }]);
  });

  test('refuses an unknown top-level key instead of stripping it', () => {
    expect(failingPaths({ ...REPORT, readiness: 1 })).toEqual(['']);
  });

  test('requires agentNotes', () => {
    expect(failingPaths(SCRIPT_REPORT)).toEqual(['agentNotes']);
  });

  test('refuses a generatedAt that is not an ISO date-time', () => {
    expect(failingPaths({ ...REPORT, generatedAt: 'yesterday' })).toEqual(['generatedAt']);
  });

  test('refuses pages out of path order, and duplicate pages', () => {
    expect(failingPaths({ ...REPORT, pages: [...REPORT.pages].reverse() })).toEqual(['pages']);
    expect(failingPaths({ ...REPORT, pages: [REPORT.pages[0], REPORT.pages[0]] })).toEqual(['pages']);
  });

  test.each([
    ['an absolute path', '/etc/page.html'],
    ['a parent segment', '../page.html'],
    // Sorts before the second page, so only the path check can fire.
    ['a backslash', 'a\\page.html'],
    ['an empty segment', 'screens//page.html'],
    ['a dot segment', './page.html'],
    ['an empty path', ''],
  ])('refuses a page path with %s', (_label, path) => {
    expect(failingPaths(withFirstPage({ path }))).toEqual(['pages.0.path']);
  });

  test('refuses a script with both src and inline', () => {
    const scripts = [{ src: 'a.js', inline: true, type: null }];

    expect(failingPaths(withFirstPage({ scripts }))).toEqual(['pages.0.scripts.0']);
  });

  test('refuses a marker that is not a data-* name, or a negative count', () => {
    expect(failingPaths(withFirstPage({ markers: { class: 1 } }))).toEqual(['pages.0.markers.class']);
    expect(failingPaths(withFirstPage({ markers: { 'data-x': -1 } }))).toEqual(['pages.0.markers.data-x']);
  });

  test('refuses marker names out of order', () => {
    const markers = { 'data-dc-screen': 1, 'data-dc-component': 3 };

    expect(failingPaths(withFirstPage({ markers }))).toEqual(['pages.0.markers']);
  });

  test('refuses tokens and variant maps out of path order', () => {
    expect(failingPaths({ ...REPORT, tokens: [...REPORT.tokens].reverse() })).toEqual(['tokens']);

    const variantMaps = [{ path: 'b/variants.ts' }, { path: 'a/variants.ts' }];

    expect(failingPaths({ ...REPORT, variantMaps })).toEqual(['variantMaps']);
  });

  test('refuses an unsorted asset group and an unknown group', () => {
    const images = ['z.svg', 'a.svg'];

    expect(failingPaths({ ...REPORT, assets: { ...REPORT.assets, images } })).toEqual(['assets.images']);
    expect(failingPaths({ ...REPORT, assets: { ...REPORT.assets, videos: [] } })).toEqual(['assets']);
  });

  test('refuses a known file whose status disagrees with its paths', () => {
    const [first, ...rest] = REPORT.knownFiles;
    const foundWithoutPaths = [{ ...first, status: 'found' }, ...rest];
    const absentWithPaths = [{ ...first, paths: ['_ds/x/_adherence.oxlintrc.json'] }, ...rest];

    expect(failingPaths({ ...REPORT, knownFiles: foundWithoutPaths })).toEqual(['knownFiles.0.status']);
    expect(failingPaths({ ...REPORT, knownFiles: absentWithPaths })).toEqual(['knownFiles.0.status']);
  });

  test('refuses knownFiles missing a name or out of order', () => {
    expect(failingPaths({ ...REPORT, knownFiles: REPORT.knownFiles.slice(1) })).toEqual(['knownFiles']);
    expect(failingPaths({ ...REPORT, knownFiles: [...REPORT.knownFiles].reverse() })).toEqual(['knownFiles']);
  });

  test('refuses a known file name outside the known list', () => {
    const knownFiles = [{ name: 'index.html', status: 'absent', paths: [] }, ...REPORT.knownFiles.slice(1)];

    expect(failingPaths({ ...REPORT, knownFiles })).toContain('knownFiles.0.name');
  });
});

describe('agentNotesSchema', () => {
  test('refuses an unknown page role', () => {
    const pageRoles = { 'a.html': { role: 'hero', reason: 'r' } };

    expect(agentNotesSchema.safeParse({ ...REPORT.agentNotes, pageRoles }).success).toBe(false);
  });

  test('refuses a version group of one page', () => {
    const versionGroups = [['a.html']];

    expect(agentNotesSchema.safeParse({ ...REPORT.agentNotes, versionGroups }).success).toBe(false);
  });

  test('refuses a boundary hint with both selector and marker, or neither', () => {
    const both = [{ page: 'a.html', selector: 'main', marker: 'data-x', note: 'n' }];
    const neither = [{ page: 'a.html', note: 'n' }];

    expect(agentNotesSchema.safeParse({ ...REPORT.agentNotes, boundaryHints: both }).success).toBe(false);
    expect(agentNotesSchema.safeParse({ ...REPORT.agentNotes, boundaryHints: neither }).success).toBe(false);
  });

  test('refuses a key outside pageRoles, versionGroups and boundaryHints', () => {
    expect(agentNotesSchema.safeParse({ ...REPORT.agentNotes, pages: [] }).success).toBe(false);
  });
});

describe('emptyAgentNotes', () => {
  test('is valid agentNotes holding nothing', () => {
    expect(agentNotesSchema.parse(emptyAgentNotes())).toStrictEqual({
      pageRoles: {},
      versionGroups: [],
      boundaryHints: [],
    });
  });

  test('completes a script report into a valid discovery report', () => {
    const report = { ...SCRIPT_REPORT, agentNotes: emptyAgentNotes() };

    expect(discoveryReportSchema.parse(report)).toStrictEqual(report);
  });

  test('returns a fresh object on every call', () => {
    expect(emptyAgentNotes()).not.toBe(emptyAgentNotes());
  });
});

describe('SCRIPT_FIELDS', () => {
  test('names the five script-owned fields', () => {
    expect(SCRIPT_FIELDS).toStrictEqual(['pages', 'tokens', 'variantMaps', 'assets', 'knownFiles']);
  });

  test('is every script report field except generatedAt, and excludes agentNotes', () => {
    const scriptKeys = Object.keys(scriptReportSchema.shape).filter((key) => key !== 'generatedAt');

    expect([...scriptKeys].sort()).toStrictEqual([...SCRIPT_FIELDS].sort());
    expect(SCRIPT_FIELDS).not.toContain('agentNotes');
  });

  test('is separated from agentNotes: the script report refuses an agentNotes key', () => {
    expect(scriptReportSchema.safeParse(REPORT).success).toBe(false);
    expect(scriptReportSchema.parse(SCRIPT_REPORT)).toStrictEqual(SCRIPT_REPORT);
  });

  test('shares no key with agentNotes', () => {
    const agentKeys: readonly string[] = Object.keys(agentNotesSchema.shape);

    expect(SCRIPT_FIELDS.filter((field) => agentKeys.includes(field))).toStrictEqual([]);
  });
});
