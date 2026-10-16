/**
 * Integration test for `bun run d2c seed`, over the whole CLI rather than
 * unit by unit: the marked fixture is run as the real package script
 * (`bun run d2c ...`), so it exercises the script wiring in `package.json`
 * too; the unmarked fixture, which needs a stub agent spawner, is run
 * through {@link run} instead, since the seed agent seam has no subprocess
 * form.
 *
 * Each case writes a throwaway `projects/<slug>.json` under the real repo
 * root — `projects/*.json` is gitignored except the tracked `example.json`,
 * so this leaves nothing to commit — pointing `source.dir` at an absolute
 * path under a temporary root, and removes both afterwards, even if the
 * assertion fails.
 *
 * Over the `marked` fixture: the run exits 0, every manifest entry carries
 * `origin: 'markers'`, `seed-rejected.json` lists nothing, and every
 * particle- or atom-level entry precedes, in the written manifest, every
 * other entry whose root element contains it on its served page — checked
 * independently against the real DOM rather than trusted from the run's
 * own ordering.
 *
 * Over the `unmarked` fixture, with a stub spawner answering the recorded
 * `unmarked-agent.txt`: the run exits 0, every accepted entry's selector
 * matches exactly one element on its served page, checked independently
 * with `page.locator(...).count()`, and each of the recording's five
 * planted bad candidates is rejected in `seed-rejected.json` with its
 * expected reason codes.
 *
 * @packageDocumentation
 */

import type { AgentSpawner } from '../pipeline/assess/agent.ts';
import type { ComponentEntry } from '../pipeline/seed/schema.ts';
import type { Browser } from 'playwright';

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { discover, writeDiscovery } from '../pipeline/assess/discover.ts';
import { readSeedManifest, seedRejectedPath } from '../pipeline/seed/files.ts';
import { withSeedPage } from '../pipeline/seed/page.ts';
import { checkUrl } from '../pipeline/serve/check.ts';
import { startServer } from '../pipeline/serve/server.ts';

import { run } from './d2c';

/** A browser launch plus several page loads with their waits, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const REPO_ROOT = join(import.meta.dirname, '..');

const PROJECTS_DIR = join(REPO_ROOT, 'projects');

const FIXTURES = join(REPO_ROOT, 'pipeline', 'seed', 'fixtures');

/** The recorded agent response proposing candidates for both unmarked pages. */
const RECORDED_RESPONSE = readFileSync(join(FIXTURES, 'recorded', 'unmarked-agent.txt'), 'utf8');

/**
 * Every planted bad candidate `unmarked-agent.txt` carries, by name, with
 * the reason codes validation must reject it with, in order.
 */
const PLANTED_REJECTIONS: readonly { readonly name: string; readonly codes: readonly string[] }[] = [
  { name: 'GalleryCard', codes: ['selector-multi-match'] },
  { name: 'GalleryPromo', codes: ['selector-no-match'] },
  { name: 'SearchBar', codes: ['contains-equal-or-higher'] },
  { name: 'FilterButton', codes: ['state-unresolved', 'state-unresolved'] },
  { name: 'Footer', codes: ['invalid-shape'] },
];

function projectPath(slug: string): string {
  return join(PROJECTS_DIR, `${slug}.json`);
}

/** A slug unique to this test run, valid under `SLUG_PATTERN`. */
function uniqueSlug(label: string): string {
  return `integration-seed-${label}-${crypto.randomUUID()}`;
}

/** One rejected entry's `candidate` read back as a plain record, when it is one. */
function candidateRecord(candidate: unknown): Record<string, unknown> | undefined {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

/**
 * Runs in the page: for each probe, the names of the other probes whose
 * root its root contains. Self-contained, since Playwright sends its
 * source and it cannot import helpers.
 */
function readContainedNames(
  probes: readonly { readonly name: string; readonly selector: string }[],
): [string, string[]][] {
  const roots = probes.map((probe) => ({ name: probe.name, element: document.querySelector(probe.selector) }));

  return roots.map((outer) => [
    outer.name,
    roots
      .filter((inner) => inner !== outer
        && outer.element !== null
        && inner.element !== null
        && outer.element.contains(inner.element))
      .map((inner) => inner.name),
  ]);
}

/** Maps each entry's name to the names of the entries its root contains, on its own page. */
async function readContainment(
  browser: Browser,
  address: string,
  components: readonly ComponentEntry[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const pagePaths = [...new Set(components.map((entry) => entry.page))].sort();
  const perPage = await Promise.all(pagePaths.map((pagePath) => withSeedPage(
    browser,
    address,
    pagePath,
    (page) => page.evaluate(readContainedNames, components
      .filter((entry) => entry.page === pagePath)
      .map((entry) => ({ name: entry.name, selector: entry.selector }))),
  )));

  return new Map(perPage.flat());
}

/**
 * Asserts that every particle- or atom-level entry of `components` has a
 * lower array index than every other entry `containment` says its root is
 * contained by.
 */
function assertLowLevelEntriesPrecedeContainers(
  components: readonly ComponentEntry[],
  containment: ReadonlyMap<string, readonly string[]>,
): void {
  const indexByName = new Map(components.map((entry, index) => [entry.name, index]));
  const levelByName = new Map(components.map((entry) => [entry.name, entry.level]));

  containment.forEach((innerNames, outerName) => {
    const outerIndex = indexByName.get(outerName);

    if (outerIndex === undefined) {
      return;
    }

    innerNames.forEach((innerName) => {
      const level = levelByName.get(innerName);
      const innerIndex = indexByName.get(innerName);

      if ((level === 'particle' || level === 'atom') && innerIndex !== undefined) {
        expect(innerIndex, `${innerName} should precede ${outerName} in the manifest`).toBeLessThan(outerIndex);
      }
    });
  });
}

/** Asserts each of `components`' selectors matches exactly one element, independently re-checked. */
async function assertSelectorsMatchExactlyOne(
  browser: Browser,
  address: string,
  components: readonly ComponentEntry[],
): Promise<void> {
  const context = await browser.newContext();

  try {
    for (const entry of components) {
      const page = await context.newPage();

      try {
        await page.goto(checkUrl(address, entry.page), { waitUntil: 'load' });
        const count = await page.locator(entry.selector).count();

        expect(count, `${entry.name}'s selector "${entry.selector}" on ${entry.page}`).toBe(1);
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
  }
}

/** Asserts every planted bad candidate is rejected with its expected reason codes. */
function assertPlantedRejections(rejected: readonly { readonly candidate: unknown; readonly reasons: readonly { readonly code: string }[] }[]): void {
  PLANTED_REJECTIONS.forEach(({ name, codes }) => {
    const rejection = rejected.find((candidate) => candidateRecord(candidate.candidate)?.name === name);

    expect(rejection, `expected a rejection named ${name}`).toBeDefined();
    expect(rejection?.reasons.map((reason) => reason.code)).toStrictEqual(codes);
  });
}

describe('bun run d2c seed over the marked fixture', () => {
  let rootDir: string;
  let sourceDir: string;
  let slug: string;

  afterEach(() => {
    rmSync(projectPath(slug), { force: true });
    rmSync(rootDir, { recursive: true, force: true });
  });

  test(
    'exits 0, every entry carries origin: markers, nothing is rejected, and '
      + 'particles and atoms precede everything containing them',
    async () => {
      rootDir = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-seed-integration-marked-'));
      sourceDir = join(rootDir, 'marked');
      slug = uniqueSlug('marked');

      cpSync(join(FIXTURES, 'marked'), sourceDir, { recursive: true });
      writeDiscovery(sourceDir, discover(sourceDir));
      mkdirSync(PROJECTS_DIR, { recursive: true });
      writeFileSync(projectPath(slug), JSON.stringify({ slug, source: { dir: sourceDir } }));

      const result = spawnSync('bun', ['run', 'd2c', 'seed'], {
        encoding: 'utf8',
        env: { ...process.env, D2C_PROJECT: slug },
        timeout: TEST_TIMEOUT_MS,
      });

      expect(result.status).toBe(0);

      const manifest = readSeedManifest(sourceDir);
      const rejectedFile = JSON.parse(readFileSync(seedRejectedPath(sourceDir), 'utf8')) as { rejected: unknown[] };

      expect(manifest.components.length).toBeGreaterThan(0);
      expect(manifest.components.every((entry) => entry.origin === 'markers')).toBe(true);
      expect(rejectedFile.rejected).toStrictEqual([]);

      const browser = await chromium.launch();

      try {
        const server = await startServer({ sourceDir, env: {}, port: 0 });

        try {
          const containment = await readContainment(browser, server.address, manifest.components);

          assertLowLevelEntriesPrecedeContainers(manifest.components, containment);
        } finally {
          await server.stop();
        }
      } finally {
        await browser.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the seed verb through run() over the unmarked fixture', () => {
  const SLUG = 'seed-unmarked';

  let rootDir: string;

  /** The project's `source.dir`, absolute under the temporary root. */
  function sourceDir(): string {
    return join(rootDir, 'design', SLUG);
  }

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test(
    'exits 0, every accepted selector matches exactly one element, and every '
      + 'planted bad entry is rejected with its reason',
    async () => {
      rootDir = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-seed-integration-unmarked-'));
      cpSync(join(FIXTURES, 'unmarked'), sourceDir(), { recursive: true });
      writeDiscovery(sourceDir(), discover(sourceDir()));
      mkdirSync(join(rootDir, 'projects'), { recursive: true });
      writeFileSync(
        join(rootDir, 'projects', `${SLUG}.json`),
        JSON.stringify({ slug: SLUG, source: { dir: `design/${SLUG}` } }),
      );

      const spawn = vi.fn<AgentSpawner>(async () => RECORDED_RESPONSE);
      const result = await run(['seed'], { env: { D2C_PROJECT: SLUG }, rootDir, spawnAgent: spawn, port: 0 });

      expect(result.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);

      const manifest = readSeedManifest(sourceDir());
      const rejectedFile = JSON.parse(readFileSync(seedRejectedPath(sourceDir()), 'utf8')) as {
        rejected: { candidate: unknown; reasons: { code: string }[] }[];
      };

      expect(manifest.components.length).toBeGreaterThan(0);
      assertPlantedRejections(rejectedFile.rejected);

      const browser = await chromium.launch();

      try {
        const server = await startServer({ sourceDir: sourceDir(), env: {}, port: 0 });

        try {
          await assertSelectorsMatchExactlyOne(browser, server.address, manifest.components);
        } finally {
          await server.stop();
        }
      } finally {
        await browser.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
