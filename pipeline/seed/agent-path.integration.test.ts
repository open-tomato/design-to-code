/**
 * Integration test for the agent path as a whole: reading the DOM outlines
 * of a served fixture export's kept pages and handing them, with the
 * discovery report's `agentNotes`, to {@link runSeedAgent}, driven by a
 * stub {@link AgentSpawner} that prints the recorded
 * `unmarked-agent.txt` response, the way the seed run will drive it over
 * an export whose kept pages carry no markers.
 *
 * Over the `unmarked` fixture, both outlines must hold the `.card` and
 * `.promo` elements with their classes, since the recording proposes
 * candidates naming both on both pages. The prompt the stub spawner
 * receives must contain both outlines and the text of `prompts/seed.md`.
 * The recording plants one candidate with an unknown key (`Footer`,
 * `confidence: 0.8`); that one candidate must come back as an
 * `invalid-shape` rejection and every other proposal in the recording must
 * come back as a candidate, stamped `origin: 'agent'`.
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

import { discover, writeDiscovery } from '../assess/discover.ts';
import { keptPages } from '../serve/check.ts';
import { startServer } from '../serve/server.ts';

import { buildSeedPrompt, runSeedAgent, SEED_PROMPT_FILE } from './agent.ts';
import { readDomOutline } from './outline.ts';
import { withSeedPage } from './page.ts';

/** A browser launch plus several page loads with their waits, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** The recorded agent response proposing candidates for both unmarked pages. */
const RECORDED_RESPONSE = readFileSync(
  join(FIXTURES, 'recorded', 'unmarked-agent.txt'),
  'utf8',
);

/** The name of the planted candidate with an unknown key. */
const PLANTED_INVALID_SHAPE_NAME = 'Footer';

let browser: Browser;
let server: RunningServer;
let sourceDir: string;
let rootDir: string;

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-seed-agent-path-'));
  sourceDir = join(rootDir, 'unmarked');

  cpSync(join(FIXTURES, 'unmarked'), sourceDir, { recursive: true });
  writeDiscovery(sourceDir, discover(sourceDir));

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

describe('the agent path over the unmarked fixture', () => {
  test('control: both kept pages carry no markers', () => {
    expect([...keptPages(sourceDir, undefined)].sort()).toStrictEqual(['gallery.html', 'index.html']);
  });

  test('both outlines hold the .card and .promo elements with their classes', async () => {
    const pages = keptPages(sourceDir, undefined);
    const outlines = await Promise.all(pages.map((pagePath) => withSeedPage(
      browser,
      server.address,
      pagePath,
      (page) => readDomOutline(page, pagePath),
    )));

    outlines.forEach((outline) => {
      const cards = outline.nodes.filter((node) => node.classes.includes('card'));
      const promos = outline.nodes.filter((node) => node.classes.includes('promo'));

      expect(cards.length + promos.length).toBeGreaterThan(0);
    });

    const galleryOutline = outlines.find((outline) => outline.page === 'gallery.html');
    const indexOutline = outlines.find((outline) => outline.page === 'index.html');

    expect(galleryOutline?.nodes.filter((node) => node.classes.includes('card'))).toHaveLength(3);
    expect(indexOutline?.nodes.filter((node) => node.classes.includes('promo'))).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  test('the prompt the stub spawner receives contains both outlines and prompts/seed.md', async () => {
    const pages = keptPages(sourceDir, undefined);
    const outlines = await Promise.all(pages.map((pagePath) => withSeedPage(
      browser,
      server.address,
      pagePath,
      (page) => readDomOutline(page, pagePath),
    )));
    const report = discover(sourceDir);
    const prompt = buildSeedPrompt(outlines, report);

    expect(prompt.startsWith(readFileSync(SEED_PROMPT_FILE, 'utf8').trimEnd())).toBe(true);
    expect(prompt).toContain('### "index.html"');
    expect(prompt).toContain('### "gallery.html"');
    outlines.forEach((outline) => {
      expect(prompt).toContain(JSON.stringify(outline, null, 2));
    });
  }, TEST_TIMEOUT_MS);

  test('the recorded response yields the planted invalid-shape candidate as a rejection and the rest as candidates', async () => {
    const pages = keptPages(sourceDir, undefined);
    const outlines = await Promise.all(pages.map((pagePath) => withSeedPage(
      browser,
      server.address,
      pagePath,
      (page) => readDomOutline(page, pagePath),
    )));
    const report = discover(sourceDir);
    const spawn = async (): Promise<string> => RECORDED_RESPONSE;

    const result = await runSeedAgent(outlines, report, spawn);

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.candidate).toEqual(
      expect.objectContaining({ name: PLANTED_INVALID_SHAPE_NAME, confidence: 0.8 }),
    );
    expect(result.rejected[0]?.reasons.map((reason) => reason.code)).toEqual(['invalid-shape']);
    expect(result.rejected[0]?.reasons[0]?.detail).toContain('Unrecognized key: "confidence"');

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((candidate) => candidate.origin === 'agent')).toBe(true);
    expect(result.candidates.some((candidate) => candidate.name === PLANTED_INVALID_SHAPE_NAME)).toBe(false);
  }, TEST_TIMEOUT_MS);
});
