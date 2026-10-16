/**
 * Integration test for the script path as a whole: `readMarkedComponents`
 * over every kept page of a served fixture export, `readDsManifests` and
 * `mergeDsManifests`, run together the way the seed run will drive them,
 * rather than unit by unit as `markers.integration.test.ts` and
 * `ds-manifest.test.ts` do.
 *
 * Over the `marked` fixture, which carries no design-system manifest, every
 * candidate the pipeline produces must come from the marker read, so every
 * one carries `origin: 'markers'`. Over the `ds-manifest` fixture, whose
 * page markers carry no `data-level`, every candidate must come from the
 * manifest merge, so every one carries `origin: 'manifest'`, and the
 * manifest's `Tooltip` entry, which names no page and matches no
 * `data-component` root, comes back as an `unlocated` rejection rather than
 * a candidate.
 *
 * @packageDocumentation
 */

import type { MarkedComponents } from './markers.ts';
import type { RunningServer } from '../serve/server.ts';
import type { Browser } from 'playwright';

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';
import { keptPages } from '../serve/check.ts';
import { startServer } from '../serve/server.ts';

import { hasFilledDsManifest, mergeDsManifests, readDsManifests } from './ds-manifest.ts';
import { readMarkedComponents } from './markers.ts';
import { withSeedPage } from './page.ts';

/** A browser launch plus several page loads with their waits, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** A served temp copy of one fixture export. */
interface Served {
  readonly sourceDir: string;
  readonly server: RunningServer;
  readonly keptPages: readonly string[];
}

const workDirs: string[] = [];

let browser: Browser;
let marked: Served;
let dsManifest: Served;

/** Copies fixture `name` into a fresh temp dir, writes its discovery report and serves it. */
async function serveCopy(name: string): Promise<Served> {
  const rootDir = mkdtempSync(join(tmpdir(), 'd2c-seed-script-path-'));
  const sourceDir = join(rootDir, name);

  workDirs.push(rootDir);
  cpSync(join(FIXTURES, name), sourceDir, { recursive: true });
  writeDiscovery(sourceDir, discover(sourceDir));

  const server = await startServer({ sourceDir, env: {}, port: 0 });

  return { sourceDir, server, keptPages: keptPages(sourceDir, undefined) };
}

/** Reads the markers of every kept page of `served`, combined into one `MarkedComponents`. */
async function readAllMarkers(served: Served): Promise<MarkedComponents> {
  const reads = await Promise.all(served.keptPages.map((pagePath) => withSeedPage(
    browser,
    served.server.address,
    pagePath,
    (page) => readMarkedComponents(page, pagePath),
  )));

  return {
    candidates: reads.flatMap((read) => read.candidates),
    rejected: reads.flatMap((read) => read.rejected),
  };
}

beforeAll(async () => {
  browser = await chromium.launch();
  marked = await serveCopy('marked');
  dsManifest = await serveCopy('ds-manifest');
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  await marked?.server.stop();
  await dsManifest?.server.stop();
  workDirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the script path over the marked fixture', () => {
  test('control: the fixture carries no design-system manifest', () => {
    const manifests = readDsManifests(marked.sourceDir, discover(marked.sourceDir).knownFiles);

    expect(manifests).toStrictEqual([]);
    expect(hasFilledDsManifest(manifests)).toBe(false);
  });

  test('every candidate the pipeline produces, across every kept page, carries origin: markers', async () => {
    const markers = await readAllMarkers(marked);
    const manifests = readDsManifests(marked.sourceDir, discover(marked.sourceDir).knownFiles);
    const merged = mergeDsManifests(manifests, markers);

    expect(merged.candidates.length).toBeGreaterThan(0);
    expect(merged.candidates.every((candidate) => candidate.origin === 'markers')).toBe(true);
    expect(merged.rejected).toStrictEqual([]);
  }, TEST_TIMEOUT_MS);
});

describe('the script path over the ds-manifest fixture', () => {
  test('control: the fixture carries a filled design-system manifest', () => {
    const manifests = readDsManifests(dsManifest.sourceDir, discover(dsManifest.sourceDir).knownFiles);

    expect(hasFilledDsManifest(manifests)).toBe(true);
  });

  test('every manifest-listed candidate carries origin: manifest, and the unlocated entry is rejected', async () => {
    const markers = await readAllMarkers(dsManifest);
    const manifests = readDsManifests(dsManifest.sourceDir, discover(dsManifest.sourceDir).knownFiles);
    const merged = mergeDsManifests(manifests, markers);

    expect(merged.candidates.length).toBeGreaterThan(0);
    expect(merged.candidates.every((candidate) => candidate.origin === 'manifest')).toBe(true);
    expect(merged.candidates.map((candidate) => candidate.name).sort()).toStrictEqual(['Breadcrumbs', 'Button', 'Tag']);

    expect(merged.rejected).toStrictEqual([{
      candidate: expect.objectContaining({ name: 'Tooltip' }) as unknown,
      reasons: [{ code: 'unlocated', detail: expect.stringContaining('the "Tooltip" entry') as unknown }],
    }]);
  }, TEST_TIMEOUT_MS);
});
