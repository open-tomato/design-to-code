/**
 * Tests for `validate.ts`: hand-written candidate lists validated by
 * {@link validateCandidates} against a served copy of the `unmarked`
 * fixture, both of whose pages are kept unless a test says otherwise.
 *
 * Every rejection is paired with a control that differs from it in the
 * one thing under test and is accepted, so each check is shown able to
 * pass as well as to fail: the multi-match and other-page selectors
 * beside a unique one, the unkept page beside the same candidate with the
 * page kept, the atom holding an atom beside the same pair as a molecule
 * holding an atom, the unresolved states beside resolving ones, and the
 * duplicate name beside its first holder.
 *
 * @packageDocumentation
 */

import type { ComponentEntry } from './schema.ts';
import type { RunningServer } from '../serve/server.ts';
import type { Browser } from 'playwright';

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { startServer } from '../serve/server.ts';

import { validateCandidates } from './validate.ts';

/** A browser launch plus both fixture pages loaded with their waits, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const FIXTURE = join(import.meta.dirname, 'fixtures', 'unmarked');

const INDEX = 'index.html';
const GALLERY = 'gallery.html';
const KEPT = [GALLERY, INDEX] as const;

let browser: Browser;
let server: RunningServer;
let rootDir: string;

/** A clean agent entry named `name`, with `fields` over the defaults. */
function entry(name: string, fields: Partial<ComponentEntry>): ComponentEntry {
  return {
    name,
    level: 'atom',
    page: INDEX,
    selector: '.search .btn',
    examples: [],
    states: [],
    variantAxes: {},
    parts: [],
    docText: [],
    origin: 'agent',
    ...fields,
  };
}

/** Validates `candidates` against the served fixture with `kept` as the kept pages. */
function validate(candidates: readonly unknown[], kept: readonly string[] = KEPT): ReturnType<typeof validateCandidates> {
  return validateCandidates(browser, server.address, kept, candidates);
}

/** The accepted names of a result, in order. */
function acceptedNames(result: Awaited<ReturnType<typeof validateCandidates>>): readonly string[] {
  return result.accepted.map((accepted) => accepted.name);
}

/** The reason codes of the rejection of the candidate named `name`. */
function codesOf(result: Awaited<ReturnType<typeof validateCandidates>>, name: string): readonly string[] {
  return reasonsOf(result, name).map((found) => found.code);
}

/** The reasons of the rejection of the candidate named `name`. */
function reasonsOf(
  result: Awaited<ReturnType<typeof validateCandidates>>,
  name: string,
): readonly { readonly code: string; readonly detail: string }[] {
  const rejection = result.rejected.find((rejected) => typeof rejected.candidate === 'object'
    && rejected.candidate !== null
    && !Array.isArray(rejected.candidate)
    && rejected.candidate.name === name);

  if (rejection === undefined) {
    throw new Error(`no rejection named ${name}`);
  }

  return rejection.reasons;
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-seed-validate-'));

  const sourceDir = join(rootDir, 'unmarked');

  cpSync(FIXTURE, sourceDir, { recursive: true });
  browser = await chromium.launch();
  server = await startServer({ sourceDir, env: {}, port: 0 });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  await server?.stop();

  if (rootDir !== undefined) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe('validateCandidates over the unmarked fixture', () => {
  test('a clean candidate is accepted unchanged', async () => {
    const clean = entry('Button', { docText: ['Search'] });

    const result = await validate([clean]);

    expect(result.accepted).toStrictEqual([clean]);
    expect(result.rejected).toStrictEqual([]);
  }, TEST_TIMEOUT_MS);

  test('a multi-match selector is rejected as selector-multi-match with its count', async () => {
    const result = await validate([
      entry('Card', { level: 'molecule', page: GALLERY, selector: '.card' }),
      entry('FirstCard', { level: 'molecule', page: GALLERY, selector: '.grid > .card:first-child' }),
    ]);

    expect(codesOf(result, 'Card')).toStrictEqual(['selector-multi-match']);
    expect(reasonsOf(result, 'Card')[0]?.detail).toContain('matches 3 elements');
    expect(acceptedNames(result)).toStrictEqual(['FirstCard']);
  }, TEST_TIMEOUT_MS);

  test('a selector valid only on another page is rejected as selector-no-match', async () => {
    const result = await validate([
      entry('Grid', { level: 'organism', page: INDEX, selector: '.grid' }),
      entry('GalleryGrid', { level: 'organism', page: GALLERY, selector: '.grid' }),
    ]);

    expect(codesOf(result, 'Grid')).toStrictEqual(['selector-no-match']);
    expect(reasonsOf(result, 'Grid')[0]?.detail).toContain(`matches 0 elements on ${INDEX}`);
    expect(acceptedNames(result)).toStrictEqual(['GalleryGrid']);
  }, TEST_TIMEOUT_MS);

  test('a selector that is not valid CSS is rejected as selector-no-match', async () => {
    const result = await validate([entry('Broken', { selector: '.search >' })]);

    expect(codesOf(result, 'Broken')).toStrictEqual(['selector-no-match']);
    expect(reasonsOf(result, 'Broken')[0]?.detail).toContain('is not a valid selector');
  }, TEST_TIMEOUT_MS);

  test('a page that is not kept is rejected as page-not-kept, and accepted once kept', async () => {
    const filter = entry('FilterButton', { page: GALLERY, selector: '.filter' });

    const unkept = await validate([filter], [INDEX]);
    const kept = await validate([filter]);

    expect(codesOf(unkept, 'FilterButton')).toStrictEqual(['page-not-kept']);
    expect(unkept.accepted).toStrictEqual([]);
    expect(kept.accepted).toStrictEqual([filter]);
  }, TEST_TIMEOUT_MS);

  test('an atom containing an atom is rejected as contains-equal-or-higher naming the contained entry', async () => {
    const result = await validate([
      entry('SearchForm', { selector: '.search' }),
      entry('Button', { selector: '.search .btn' }),
    ]);

    expect(codesOf(result, 'SearchForm')).toStrictEqual(['contains-equal-or-higher']);
    expect(reasonsOf(result, 'SearchForm')[0]?.detail).toContain('contains Button');
    expect(acceptedNames(result)).toStrictEqual(['Button']);
  }, TEST_TIMEOUT_MS);

  test('an atom containing a molecule is rejected as contains-equal-or-higher naming the contained entry', async () => {
    const result = await validate([
      entry('Header', { selector: '.site-header' }),
      entry('Menu', { level: 'molecule', selector: '.menu' }),
    ]);

    expect(codesOf(result, 'Header')).toStrictEqual(['contains-equal-or-higher']);
    expect(reasonsOf(result, 'Header')[0]?.detail).toContain('contains Menu');
    expect(acceptedNames(result)).toStrictEqual(['Menu']);
  }, TEST_TIMEOUT_MS);

  test('a molecule containing an atom is accepted with the atom', async () => {
    const result = await validate([
      entry('SearchForm', { level: 'molecule', selector: '.search' }),
      entry('Button', { selector: '.search .btn' }),
    ]);

    expect(result.rejected).toStrictEqual([]);
    expect(acceptedNames(result)).toStrictEqual(['SearchForm', 'Button']);
  }, TEST_TIMEOUT_MS);

  test('an example state matching nothing and an action target outside the component are rejected as state-unresolved', async () => {
    const result = await validate([
      entry('FilterButton', {
        page: GALLERY,
        selector: '.filter',
        states: [{ name: 'active', mode: 'example', selector: '.filter.is-active' }],
      }),
      entry('Menu', {
        level: 'molecule',
        selector: '.menu',
        states: [{ name: 'hover', mode: 'action', action: 'hover', target: '.btn' }],
      }),
    ]);

    expect(codesOf(result, 'FilterButton')).toStrictEqual(['state-unresolved']);
    expect(reasonsOf(result, 'FilterButton')[0]?.detail).toContain('"active"');
    expect(codesOf(result, 'Menu')).toStrictEqual(['state-unresolved']);
    expect(reasonsOf(result, 'Menu')[0]?.detail).toContain('target ".btn" matches 0 elements inside ".menu"');
    expect(result.accepted).toStrictEqual([]);
  }, TEST_TIMEOUT_MS);

  test('control: an example state that matches and action targets inside the component, root included, resolve', async () => {
    const result = await validate([
      entry('FilterButton', {
        page: GALLERY,
        selector: '.filter',
        states: [{ name: 'default', mode: 'example', selector: '.filter' }],
      }),
      entry('Menu', {
        level: 'molecule',
        selector: '.menu',
        states: [{ name: 'hover', mode: 'action', action: 'hover', target: '.menu-label' }],
      }),
      entry('Button', {
        states: [{ name: 'focus', mode: 'action', action: 'focus', target: '.btn' }],
      }),
    ]);

    expect(result.rejected).toStrictEqual([]);
    expect(acceptedNames(result)).toStrictEqual(['FilterButton', 'Menu', 'Button']);
  }, TEST_TIMEOUT_MS);

  test('every failing state is reported, not only the first', async () => {
    const result = await validate([
      entry('FilterButton', {
        page: GALLERY,
        selector: '.filter',
        states: [
          { name: 'active', mode: 'example', selector: '.filter.is-active' },
          { name: 'pressed', mode: 'action', action: 'press', target: '.filter-icon' },
        ],
      }),
    ]);

    expect(codesOf(result, 'FilterButton')).toStrictEqual(['state-unresolved', 'state-unresolved']);
  }, TEST_TIMEOUT_MS);

  test('an example matching nothing is rejected as example-no-match', async () => {
    const result = await validate([
      entry('CardTitle', { page: GALLERY, selector: '.grid > .card:first-child .card-title', examples: ['.card-title', '.promo'] }),
    ]);

    expect(codesOf(result, 'CardTitle')).toStrictEqual(['example-no-match']);
    expect(reasonsOf(result, 'CardTitle')[0]?.detail).toContain('".promo"');
  }, TEST_TIMEOUT_MS);

  test('a duplicate name is rejected as duplicate-name and the first holder is accepted', async () => {
    const first = entry('Promo', { level: 'organism', selector: '.promo' });

    const result = await validate([first, entry('Promo', { level: 'organism', selector: '.site-footer' })]);

    expect(result.accepted).toStrictEqual([first]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.candidate).toEqual(expect.objectContaining({ selector: '.site-footer' }));
    expect(result.rejected[0]?.reasons.map((found) => found.code)).toStrictEqual(['duplicate-name']);
  }, TEST_TIMEOUT_MS);

  test('a candidate stops at its first failing step and keeps its input order', async () => {
    const result = await validate([
      { name: 'Loose', level: 'atom' },
      entry('Promo', { level: 'organism', selector: '.promo' }),
      entry('Promo', { page: 'missing.html', selector: '.nowhere' }),
      entry('Card', { level: 'molecule', page: GALLERY, selector: '.card', examples: ['.nowhere'] }),
    ]);

    expect(result.rejected.map((rejected) => rejected.reasons.map((found) => found.code))).toStrictEqual([
      ['invalid-shape'],
      ['duplicate-name'],
      ['selector-multi-match'],
    ]);
    expect(acceptedNames(result)).toStrictEqual(['Promo']);
  }, TEST_TIMEOUT_MS);
});
