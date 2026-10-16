/**
 * Integration test for validation and order together: the recorded
 * `unmarked-agent.txt` candidates run through {@link validateCandidates}
 * and {@link extractionOrder} against a served copy of the `unmarked`
 * fixture, the way a seed run drives them once the agent path has proposed
 * candidates for a page with no markers.
 *
 * The recording plants five bad candidates among its ten: `GalleryCard`
 * (`.card` on gallery.html, three matches) rejected as
 * `selector-multi-match`; `GalleryPromo` (`.promo`, valid only on
 * index.html) rejected as `selector-no-match`; `SearchBar` (`.search` on
 * index.html, containing the atom `Button`) rejected as
 * `contains-equal-or-higher`; `FilterButton`, whose `active` example and
 * `pressed` action target both resolve nowhere, rejected with two
 * `state-unresolved` reasons; and `Footer`, carrying an unknown
 * `confidence` key, rejected as `invalid-shape`. The other five (`Menu`,
 * `Button`, `Promo`, `Card`, `CardTitle`) are accepted; each accepted
 * selector is re-checked independently with `page.locator(...).count()`
 * rather than trusted from the validator's own reading. `extractionOrder`
 * then places the atoms `Button` and `CardTitle` before the molecule
 * `Card`, which contains `CardTitle`, and before the molecule `Menu` and
 * the organism `Promo`.
 *
 * @packageDocumentation
 */

import type { RunningServer } from '../serve/server.ts';
import type { Browser } from 'playwright';

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';

import { extractJsonObject } from '../assess/agent.ts';
import { discover, writeDiscovery } from '../assess/discover.ts';
import { checkUrl, keptPages } from '../serve/check.ts';
import { startServer } from '../serve/server.ts';

import { assertContainmentOrder, extractionOrder } from './order.ts';
import { validateCandidates } from './validate.ts';

/** A browser launch plus several page loads with their waits, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** The recorded agent response proposing candidates for both unmarked pages. */
const RECORDED_RESPONSE = readFileSync(join(FIXTURES, 'recorded', 'unmarked-agent.txt'), 'utf8');

/** The shape the recorded response's one JSON object must hold, before any per-entry check. */
const recordedAnswerSchema = z.object({
  components: z.array(z.record(z.string(), z.unknown())),
});

/** Every planted bad candidate's name and the reason codes it must be rejected with, in order. */
const PLANTED_REJECTIONS: readonly { readonly name: string; readonly codes: readonly string[] }[] = [
  { name: 'GalleryCard', codes: ['selector-multi-match'] },
  { name: 'GalleryPromo', codes: ['selector-no-match'] },
  { name: 'SearchBar', codes: ['contains-equal-or-higher'] },
  { name: 'FilterButton', codes: ['state-unresolved', 'state-unresolved'] },
  { name: 'Footer', codes: ['invalid-shape'] },
];

/** The names extraction order must place, lowest level first: the atoms, then the molecules, then the organism. */
const EXPECTED_ORDER = ['CardTitle', 'Button', 'Card', 'Menu', 'Promo'];

let browser: Browser;
let server: RunningServer;
let rootDir: string;
let sourceDir: string;
let candidates: readonly unknown[];

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-seed-validate-integration-'));
  sourceDir = join(rootDir, 'unmarked');

  cpSync(join(FIXTURES, 'unmarked'), sourceDir, { recursive: true });
  writeDiscovery(sourceDir, discover(sourceDir));

  browser = await chromium.launch();
  server = await startServer({ sourceDir, env: {}, port: 0 });

  const answer = recordedAnswerSchema.parse(extractJsonObject(RECORDED_RESPONSE));

  candidates = answer.components.map((component) => ({ ...component, origin: 'agent' }));
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  await server?.stop();

  if (rootDir !== undefined) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/** Runs `validateCandidates` over the recorded candidates against both kept fixture pages. */
function validateRecorded(): ReturnType<typeof validateCandidates> {
  return validateCandidates(browser, server.address, keptPages(sourceDir, undefined), candidates);
}

describe('validateCandidates over the recorded unmarked-agent.txt candidates', () => {
  test('control: the recording proposes ten candidates', () => {
    expect(candidates).toHaveLength(10);
  });

  test('every planted bad candidate is rejected with its expected reason codes', async () => {
    const result = await validateRecorded();

    PLANTED_REJECTIONS.forEach(({ name, codes }) => {
      const rejection = result.rejected.find((rejected) => typeof rejected.candidate === 'object'
        && rejected.candidate !== null
        && !Array.isArray(rejected.candidate)
        && rejected.candidate.name === name);

      expect(rejection, `expected a rejection named ${name}`).toBeDefined();
      expect(rejection?.reasons.map((reason) => reason.code)).toStrictEqual(codes);
    });
    expect(result.rejected).toHaveLength(PLANTED_REJECTIONS.length);
  }, TEST_TIMEOUT_MS);

  test('every other candidate is accepted', async () => {
    const result = await validateRecorded();
    const rejectedNames = new Set(PLANTED_REJECTIONS.map((planted) => planted.name));
    const expectedAccepted = candidates
      .map((candidate) => (candidate as { readonly name: string }).name)
      .filter((name) => !rejectedNames.has(name));

    expect(result.accepted.map((entry) => entry.name).sort()).toStrictEqual([...expectedAccepted].sort());
  }, TEST_TIMEOUT_MS);

  test('every accepted entry\'s selector matches exactly one element on its page, re-checked independently', async () => {
    const result = await validateRecorded();

    expect(result.accepted.length).toBeGreaterThan(0);

    const context = await browser.newContext();

    try {
      for (const entry of result.accepted) {
        const page = await context.newPage();

        try {
          await page.goto(checkUrl(server.address, entry.page), { waitUntil: 'load' });
          const count = await page.locator(entry.selector).count();

          expect(count, `${entry.name}'s selector "${entry.selector}" on ${entry.page}`).toBe(1);
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
    }
  }, TEST_TIMEOUT_MS);

  test('extractionOrder lists the atoms and molecules that contain them in the right order', async () => {
    const result = await validateRecorded();
    const ordered = extractionOrder(result.accepted);

    expect(ordered.map((entry) => entry.name)).toStrictEqual(EXPECTED_ORDER);

    // Card contains CardTitle: assertContainmentOrder must accept the order
    // extractionOrder produced, the way the manifest writer will use it.
    expect(() => assertContainmentOrder(ordered, new Map([['Card', ['CardTitle']]]))).not.toThrow();
  }, TEST_TIMEOUT_MS);
});
