/**
 * Tests for `ds-manifest.ts`, with no browser: the reads run over temp
 * copies of the `ds-manifest` fixture, each with its `discovery.json`
 * written, so `knownFiles` comes from `discover` itself; the merges take
 * marker reads built by hand in the shape `readMarkedComponents` returns
 * for that fixture's page (its `Button` and `Tag` roots carry no
 * `data-level`, so both come back as `missing-level` rejections).
 *
 * Each claim is paired with a control that could have failed it: the
 * fixture's own manifest reads as filled beside the empty one read as not
 * filled, and the `Button` root stays a `missing-level` rejection when no
 * manifest names it.
 *
 * @packageDocumentation
 */

import type { DsManifest } from './ds-manifest.ts';
import type { MarkedComponents } from './markers.ts';
import type { ComponentEntry, RejectedCandidate } from './schema.ts';

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { discover } from '../assess/discover.ts';

import { DsManifestError, hasFilledDsManifest, mergeDsManifests, readDsManifests } from './ds-manifest.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'ds-manifest');

/** The fixture's manifest, relative to the source dir. */
const MANIFEST_PATH = '_ds/ds_fixture/_ds_manifest.json';

const workDirs: string[] = [];

/** Copies the `ds-manifest` fixture into a fresh temp dir and returns the copy. */
function fixtureCopy(): string {
  const rootDir = mkdtempSync(join(tmpdir(), 'd2c-seed-ds-manifest-'));
  const sourceDir = join(rootDir, 'ds-manifest');

  workDirs.push(rootDir);
  cpSync(FIXTURE, sourceDir, { recursive: true });

  return sourceDir;
}

/** Reads the manifests of `sourceDir` as discovery finds them. */
function readFound(sourceDir: string): readonly DsManifest[] {
  return readDsManifests(sourceDir, discover(sourceDir).knownFiles);
}

/** A `missing-level` rejection as `readMarkedComponents` returns one for a levelless root. */
function levellessRoot(name: string, page: string, selector: string): RejectedCandidate {
  return {
    candidate: { name, page, selector, examples: [], states: [], variantAxes: {}, parts: [], docText: [], origin: 'markers' },
    reasons: [{ code: 'missing-level', detail: `the "${name}" root ${selector} on ${page} has no data-level` }],
  };
}

/** A marker candidate with the defaults `readMarkedComponents` gives a bare root. */
function markerCandidate(fields: Pick<ComponentEntry, 'name' | 'level' | 'page' | 'selector'> & Partial<ComponentEntry>): ComponentEntry {
  return { examples: [], states: [], variantAxes: {}, parts: [], docText: [], origin: 'markers', ...fields };
}

/** The marker read of the fixture's `index.html`: `Button` and `Tag`, neither with a level. */
const FIXTURE_MARKERS: MarkedComponents = {
  candidates: [],
  rejected: [
    levellessRoot('Button', 'index.html', 'html > body > main > button'),
    levellessRoot('Tag', 'index.html', 'html > body > main > span'),
  ],
};

/** A one-file manifest holding `components`. */
function manifestOf(components: DsManifest['components']): DsManifest {
  return { path: MANIFEST_PATH, filled: components.length > 0, components };
}

/** The entry named `name` among `candidates`, failing the test when there is none. */
function entryNamed(candidates: readonly ComponentEntry[], name: string): ComponentEntry {
  const found = candidates.find((candidate) => candidate.name === name);

  if (found === undefined) {
    throw new Error(`no entry named ${name}`);
  }

  return found;
}

afterEach(() => {
  workDirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('readDsManifests', () => {
  test('control: reads the fixture manifest as filled, its four entries as written', () => {
    const manifests = readFound(fixtureCopy());

    expect(manifests.map(({ path, filled, components }) => ({ path, filled, count: components.length }))).toStrictEqual([
      { path: MANIFEST_PATH, filled: true, count: 4 },
    ]);
    expect(hasFilledDsManifest(manifests)).toBe(true);
  });

  test('reads an empty components list as not filled', () => {
    const sourceDir = fixtureCopy();

    writeFileSync(join(sourceDir, MANIFEST_PATH), '{ "id": "ds_fixture", "components": [] }\n');

    const manifests = readFound(sourceDir);

    expect(manifests).toStrictEqual([{ path: MANIFEST_PATH, filled: false, components: [] }]);
    expect(hasFilledDsManifest(manifests)).toBe(false);
  });

  test('reads nothing when discovery found no manifest', () => {
    const sourceDir = fixtureCopy();

    rmSync(join(sourceDir, '_ds'), { recursive: true });

    expect(readFound(sourceDir)).toStrictEqual([]);
  });

  test.each([
    { flaw: 'is not JSON', text: '{ "components": [', reason: /cannot be read as JSON/ },
    { flaw: 'has components as an object', text: '{ "components": { "Button": {} } }', reason: /`components` is not a list/ },
    { flaw: 'has no components key', text: '{ "id": "ds_fixture" }', reason: /`components` is not a list/ },
  ])('throws DsManifestError naming the path when the file $flaw', ({ text, reason }) => {
    const sourceDir = fixtureCopy();
    const knownFiles = discover(sourceDir).knownFiles;
    const path = join(sourceDir, MANIFEST_PATH);

    writeFileSync(path, text);

    expect(() => readDsManifests(sourceDir, knownFiles)).toThrow(DsManifestError);
    expect(() => readDsManifests(sourceDir, knownFiles)).toThrow(reason);
    expect(() => readDsManifests(sourceDir, knownFiles)).toThrow(`${path}: `);
  });
});

describe('mergeDsManifests over the fixture manifest', () => {
  test('control: with no manifest, the levelless Button root stays a missing-level rejection', () => {
    const merged = mergeDsManifests([], FIXTURE_MARKERS);

    expect(merged).toStrictEqual({ candidates: [], rejected: FIXTURE_MARKERS.rejected });
  });

  test('fills the level of a marker root with no data-level from the manifest, taking its fields and origin', () => {
    const merged = mergeDsManifests(readFound(fixtureCopy()), FIXTURE_MARKERS);

    expect(entryNamed(merged.candidates, 'Button')).toStrictEqual({
      name: 'Button',
      level: 'atom',
      page: 'index.html',
      selector: 'html > body > main > button',
      examples: [],
      states: [],
      variantAxes: { intent: ['primary', 'secondary'] },
      parts: [],
      docText: ['Buttons trigger an action.'],
      origin: 'manifest',
    });
    expect(merged.rejected.map((rejected) => rejected.reasons[0]?.code)).not.toContain('missing-level');
  });

  test('keeps an entry with an explicit page and selector as written', () => {
    const merged = mergeDsManifests(readFound(fixtureCopy()), FIXTURE_MARKERS);

    expect(entryNamed(merged.candidates, 'Breadcrumbs')).toStrictEqual({
      name: 'Breadcrumbs',
      level: 'molecule',
      page: 'index.html',
      selector: '#breadcrumbs',
      examples: [],
      states: [],
      variantAxes: {},
      parts: [],
      docText: ['Breadcrumbs show where the page sits.'],
      origin: 'manifest',
    });
  });

  test('rejects an entry located nowhere as unlocated, keeping the entry as written', () => {
    const merged = mergeDsManifests(readFound(fixtureCopy()), FIXTURE_MARKERS);

    expect(merged.candidates.map((candidate) => candidate.name)).toStrictEqual(['Button', 'Tag', 'Breadcrumbs']);
    expect(merged.rejected).toStrictEqual([{
      candidate: {
        name: 'Tooltip',
        level: 'atom',
        description: 'Tooltips are listed but appear on no page.',
      },
      reasons: [{
        code: 'unlocated',
        detail: `the "Tooltip" entry of ${MANIFEST_PATH} gives no page and selector, and no kept page has a data-component="Tooltip" root`,
      }],
    }]);
  });
});

describe('mergeDsManifests rules', () => {
  test('lets manifest fields win over a leveled marker candidate, keeping its placement and parts', () => {
    const marker = markerCandidate({
      name: 'Button',
      level: 'particle',
      page: 'index.html',
      selector: 'form#search > button',
      examples: ['main > button'],
      variantAxes: { size: ['small'] },
      parts: ['label'],
      docText: ['From the page.'],
    });
    const merged = mergeDsManifests(
      [manifestOf([{ name: 'Button', level: 'atom', description: '  From the manifest.  ', variants: { intent: ['secondary', 'primary', 'primary'] } }])],
      { candidates: [marker], rejected: [] },
    );

    expect(merged).toStrictEqual({
      candidates: [{
        ...marker,
        level: 'atom',
        variantAxes: { intent: ['primary', 'secondary'] },
        docText: ['From the manifest.'],
        origin: 'manifest',
      }],
      rejected: [],
    });
  });

  test('keeps marker fields the manifest leaves out, and passes unclaimed marker candidates through', () => {
    const button = markerCandidate({ name: 'Button', level: 'atom', page: 'index.html', selector: 'button', docText: ['Doc.'] });
    const icon = markerCandidate({ name: 'Icon', level: 'particle', page: 'index.html', selector: 'i' });
    const merged = mergeDsManifests([manifestOf([{ name: 'Button', level: null, extra: true }])], { candidates: [button, icon], rejected: [] });

    expect(merged.candidates).toStrictEqual([icon, { ...button, origin: 'manifest' }]);
  });

  test('locates by the root on the first page by path, dropping the same name on later pages', () => {
    const later = markerCandidate({ name: 'Button', level: 'atom', page: 'z.html', selector: 'button' });
    const first = markerCandidate({ name: 'Button', level: 'atom', page: 'a.html', selector: 'main > button' });
    const merged = mergeDsManifests([manifestOf([{ name: 'Button' }])], { candidates: [later, first], rejected: [] });

    expect(merged.candidates).toStrictEqual([{ ...first, origin: 'manifest' }]);
  });

  test('rejects an entry with neither a manifest level nor a valid marker level as missing-level', () => {
    const merged = mergeDsManifests([manifestOf([{ name: 'Tag' }])], FIXTURE_MARKERS);

    expect(merged.rejected).toMatchObject([
      FIXTURE_MARKERS.rejected[0],
      {
        candidate: { name: 'Tag', selector: 'html > body > main > span', origin: 'manifest' },
        reasons: [{ code: 'missing-level', detail: `the "Tag" entry of ${MANIFEST_PATH} gives no level, and its root html > body > main > span on index.html has no valid data-level` }],
      },
    ]);
  });

  test('rejects a nameless entry, a lone page and a bad level as invalid-shape, and a repeated name as duplicate-name', () => {
    const merged = mergeDsManifests([
      manifestOf([{ level: 'atom' }, { name: 'Card', page: 'index.html' }, { name: 'Chip', level: 'huge' }, 'Button', { name: 'Button', level: 'atom' }]),
      { path: 'other/_ds_manifest.json', filled: true, components: [{ name: 'Button', level: 'molecule' }] },
    ], FIXTURE_MARKERS);

    expect(merged.candidates.map(({ name, level }) => ({ name, level }))).toStrictEqual([{ name: 'Button', level: 'atom' }]);
    expect(merged.rejected.map((rejected) => rejected.reasons.map((reason) => reason.code))).toStrictEqual([
      ['missing-level'],
      ['invalid-shape'],
      ['invalid-shape'],
      ['invalid-shape'],
      ['invalid-shape'],
      ['duplicate-name'],
    ]);
    expect(merged.rejected[2]?.reasons[0]?.detail).toContain('page and selector must be given together');
    expect(merged.rejected[5]?.reasons[0]?.detail).toBe(`the "Button" entry of other/_ds_manifest.json repeats a name ${MANIFEST_PATH} already lists`);
  });

  test('leaves its inputs unmutated', () => {
    const markers = structuredClone(FIXTURE_MARKERS);
    const manifests = readFound(fixtureCopy());
    const before = structuredClone(manifests);

    mergeDsManifests(manifests, markers);

    expect(markers).toStrictEqual(FIXTURE_MARKERS);
    expect(manifests).toStrictEqual(before);
  });
});
