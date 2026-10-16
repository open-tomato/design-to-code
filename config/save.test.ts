import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { loadProjectConfig, ProjectConfigError } from './load.ts';
import { savePageChoice } from './save.ts';

const SLUG = 'homepage';

const ENV = { D2C_PROJECT: SLUG };

let rootDir: string;

function projectPath(): string {
  return join(rootDir, 'projects', `${SLUG}.json`);
}

/** Writes `projects/<slug>.json` under the temporary root, as given. */
function writeProjectText(text: string): void {
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(projectPath(), text);
}

function writeProject(content: unknown): void {
  writeProjectText(JSON.stringify(content));
}

function readProject(): unknown {
  return JSON.parse(readFileSync(projectPath(), 'utf8'));
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-config-save-test-'));
  mkdirSync(join(rootDir, 'design', SLUG), { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('savePageChoice', () => {
  test('writes a file that still loads, with the page in the chosen list', () => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });

    const choices = savePageChoice(SLUG, 'Rafa Portal.dc.html', 'discard', { rootDir });
    const config = loadProjectConfig({ env: ENV, rootDir });

    expect(choices).toStrictEqual({ keep: [], discard: ['Rafa Portal.dc.html'] });
    expect(config.pages).toStrictEqual({ discard: ['Rafa Portal.dc.html'] });
  });

  test('keeps every other field as written and bakes in no default', () => {
    const written = {
      slug: SLUG,
      source: { dir: `design/${SLUG}`, shareLink: 'https://example.com/share' },
      storybook: {},
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
      unknownKey: { kept: true },
      pages: { note: 'hand-written', keep: ['b.html'] },
    };

    writeProject(written);
    savePageChoice(SLUG, 'a.html', 'keep', { rootDir });

    expect(readProject()).toStrictEqual({
      ...written,
      pages: { note: 'hand-written', keep: ['a.html', 'b.html'] },
    });
  });

  test('writes 2-space JSON with a trailing newline and leaves no temp file', () => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });

    savePageChoice(SLUG, 'index.html', 'keep', { rootDir });

    const text = readFileSync(projectPath(), 'utf8');

    expect(text).toBe(`${JSON.stringify(readProject(), null, 2)}\n`);
    expect(readdirSync(join(rootDir, 'projects'))).toStrictEqual([`${SLUG}.json`]);
  });

  test('moves a page out of the other list, keeping both sorted and unique', () => {
    writeProject({
      slug: SLUG,
      source: { dir: `design/${SLUG}` },
      pages: { keep: ['z.html', 'x.html', 'x.html'], discard: ['y.html', 'x.html'] },
    });

    const discarded = savePageChoice(SLUG, 'x.html', 'discard', { rootDir });

    expect(discarded).toStrictEqual({ keep: ['z.html'], discard: ['x.html', 'y.html'] });

    const kept = savePageChoice(SLUG, 'x.html', 'keep', { rootDir });

    expect(kept).toStrictEqual({ keep: ['x.html', 'z.html'], discard: ['y.html'] });
    expect(readProject()).toMatchObject({ pages: kept });
    expect(loadProjectConfig({ env: ENV, rootDir }).pages).toStrictEqual(kept);
  });

  test('marking a page twice with the same choice lists it once', () => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });

    savePageChoice(SLUG, 'a.html', 'keep', { rootDir });

    expect(savePageChoice(SLUG, 'a.html', 'keep', { rootDir })).toStrictEqual({
      keep: ['a.html'],
      discard: [],
    });
  });

  test('re-reads the file on every write', () => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });
    savePageChoice(SLUG, 'a.html', 'keep', { rootDir });
    writeProject({ slug: SLUG, name: 'Edited', source: { dir: `design/${SLUG}` } });

    savePageChoice(SLUG, 'b.html', 'discard', { rootDir });

    expect(readProject()).toStrictEqual({
      slug: SLUG,
      name: 'Edited',
      source: { dir: `design/${SLUG}` },
      pages: { discard: ['b.html'] },
    });
  });

  test('leaves the file untouched when validation fails', () => {
    const text = JSON.stringify({ slug: SLUG, source: { dir: `design/${SLUG}` }, viewports: [] });

    writeProjectText(text);

    expect(() => savePageChoice(SLUG, 'a.html', 'keep', { rootDir })).toThrow(
      new ProjectConfigError('projects/homepage.json: invalid project config\n  viewports: Too small: expected array to have >=1 items'),
    );
    expect(readFileSync(projectPath(), 'utf8')).toBe(text);
    expect(readdirSync(join(rootDir, 'projects'))).toStrictEqual([`${SLUG}.json`]);
  });

  test('rejects an empty page name without writing', () => {
    const text = JSON.stringify({ slug: SLUG, source: { dir: `design/${SLUG}` } });

    writeProjectText(text);

    expect(() => savePageChoice(SLUG, '', 'discard', { rootDir })).toThrow(/pages\.discard\.0: /);
    expect(readFileSync(projectPath(), 'utf8')).toBe(text);
  });

  test('rejects a pages value that is not an object without writing', () => {
    const text = JSON.stringify({ slug: SLUG, source: { dir: `design/${SLUG}` }, pages: [] });

    writeProjectText(text);

    expect(() => savePageChoice(SLUG, 'a.html', 'keep', { rootDir })).toThrow(/pages: expected an object/);
    expect(readFileSync(projectPath(), 'utf8')).toBe(text);
  });

  test('names a missing file, invalid JSON and a bad slug', () => {
    expect(() => savePageChoice(SLUG, 'a.html', 'keep', { rootDir })).toThrow(
      new ProjectConfigError('projects/homepage.json: project file not found'),
    );

    writeProjectText('{');

    expect(() => savePageChoice(SLUG, 'a.html', 'keep', { rootDir })).toThrow(/not valid JSON/);
    expect(() => savePageChoice('../x', 'a.html', 'keep', { rootDir })).toThrow(/is not a slug/);
  });
});
