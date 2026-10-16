/**
 * Tests for {@link runSeed} over served temp copies of the seed fixture
 * exports, with a stub {@link AgentSpawner}: the agent is never run.
 *
 * The refusals that need no browser are proved to come before any server
 * starts by running them with `D2C_PORT` set to a value `startServer`
 * refuses: a refusal of its own, rather than the port error, means the
 * server was never reached. A control runs the same environment over a
 * copy that passes those checks and gets the port error, so the check
 * could have failed. The same refused `D2C_PORT` shows the test-only `port`
 * option reaching `startServer`: with `port: 0` the run completes.
 *
 * @packageDocumentation
 */

import type { AgentSpawner } from '../assess/agent.ts';

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';
import { OS_ASSIGNED_PORT, ServePortError } from '../serve/port.ts';

import { readSeedManifest, seedManifestPath, seedRejectedPath } from './files.ts';
import { DISCOVERY_COMMAND, runSeed, SeedRefusedError } from './run.ts';

/** A browser launch plus several page loads with their waits, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** The recorded agent response proposing candidates for both unmarked pages. */
const RECORDED_RESPONSE = readFileSync(join(FIXTURES, 'recorded', 'unmarked-agent.txt'), 'utf8');

/** A `D2C_PORT` that `startServer` refuses with a `ServePortError`. */
const REFUSED_PORT_ENV = { D2C_PORT: 'not-a-port' };

/** The fixed clock every run reads `generatedAt` from. */
const NOW = new Date('2026-09-30T12:00:00.000Z');

const workDirs: string[] = [];

/** A stub spawner answering `response`, with every prompt it was called with. */
interface StubSpawner {
  readonly spawn: AgentSpawner;
  readonly prompts: readonly string[];
}

/** A stub spawner that answers every call with `response` and records the prompt. */
function stubSpawner(response: string): StubSpawner {
  const prompts: string[] = [];

  return {
    prompts,
    spawn: async (prompt) => {
      prompts.push(prompt);

      return response;
    },
  };
}

/** Copies fixture `name` into a fresh temp dir, writing its discovery report unless told not to. */
function copyFixture(name: string, withDiscovery = true): string {
  const rootDir = mkdtempSync(join(tmpdir(), 'd2c-seed-run-'));
  const sourceDir = join(rootDir, name);

  workDirs.push(rootDir);
  cpSync(join(FIXTURES, name), sourceDir, { recursive: true });

  if (withDiscovery) {
    writeDiscovery(sourceDir, discover(sourceDir));
  }

  return sourceDir;
}

/** Runs seed over `sourceDir` with every page kept, the fixed clock, no `D2C_PORT` and a port the OS assigns. */
function seed(sourceDir: string, spawn: AgentSpawner): ReturnType<typeof runSeed> {
  return runSeed({ sourceDir, pages: undefined, spawn, now: () => NOW, env: {}, port: OS_ASSIGNED_PORT });
}

/** The `name` of a rejected candidate, when it is an object carrying one. */
function candidateName(candidate: unknown): unknown {
  return typeof candidate === 'object' && candidate !== null && 'name' in candidate
    ? candidate.name
    : undefined;
}

afterEach(() => {
  workDirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('runSeed refusals before any server starts', () => {
  test('control: with discovery.json present, the refused D2C_PORT reaches startServer and fails there', async () => {
    const sourceDir = copyFixture('marked');
    const stub = stubSpawner(RECORDED_RESPONSE);

    await expect(runSeed({ sourceDir, pages: undefined, spawn: stub.spawn, env: REFUSED_PORT_ENV }))
      .rejects.toBeInstanceOf(ServePortError);
  });

  test('no discovery.json is refused naming the assess command, before any server starts', async () => {
    const sourceDir = copyFixture('marked', false);
    const stub = stubSpawner(RECORDED_RESPONSE);
    const run = runSeed({ sourceDir, pages: undefined, spawn: stub.spawn, env: REFUSED_PORT_ENV });

    await expect(run).rejects.toBeInstanceOf(SeedRefusedError);
    await expect(run).rejects.toThrow(`run \`${DISCOVERY_COMMAND}\` first`);
    expect(DISCOVERY_COMMAND).toBe('bun run d2c assess --scripts-only');
    expect(stub.prompts).toHaveLength(0);
    expect(existsSync(seedManifestPath(sourceDir))).toBe(false);
    expect(existsSync(seedRejectedPath(sourceDir))).toBe(false);
  });

  test('no kept page is refused before any server starts', async () => {
    const sourceDir = copyFixture('marked');
    const stub = stubSpawner(RECORDED_RESPONSE);
    const run = runSeed({
      sourceDir,
      pages: { discard: ['index.html', 'widgets.html'] },
      spawn: stub.spawn,
      env: REFUSED_PORT_ENV,
    });

    await expect(run).rejects.toBeInstanceOf(SeedRefusedError);
    await expect(run).rejects.toThrow('pages.discard lists all 2 pages discovery found');
    expect(stub.prompts).toHaveLength(0);
  });
});

describe('runSeed with the test-only port option', () => {
  test('port 0 reaches startServer and outranks a refused D2C_PORT', async () => {
    const sourceDir = copyFixture('marked');
    const stub = stubSpawner(RECORDED_RESPONSE);

    const result = await runSeed({
      sourceDir,
      pages: undefined,
      spawn: stub.spawn,
      now: () => NOW,
      env: REFUSED_PORT_ENV,
      port: OS_ASSIGNED_PORT,
    });

    expect(result.manifest.components).not.toHaveLength(0);
    expect(readSeedManifest(sourceDir)).toStrictEqual(result.manifest);
  }, TEST_TIMEOUT_MS);
});

describe('runSeed over the marked fixture', () => {
  test('never calls the spawner and writes every marker entry in extraction order', async () => {
    const sourceDir = copyFixture('marked');
    const stub = stubSpawner(RECORDED_RESPONSE);

    const result = await seed(sourceDir, stub.spawn);

    expect(stub.prompts).toHaveLength(0);
    expect(result.agentRan).toBe(false);
    expect(result.manifest.components.map((entry) => entry.name))
      .toStrictEqual(['Icon', 'Button', 'Badge', 'SearchField', 'Header']);
    expect(result.manifest.components.every((entry) => entry.origin === 'markers')).toBe(true);
    expect(result.rejected).toStrictEqual([]);
    expect(readSeedManifest(sourceDir)).toStrictEqual(result.manifest);
    expect(result.manifest.generatedAt).toBe(NOW.toISOString());
  }, TEST_TIMEOUT_MS);

  test('a rerun replaces a stale seed-rejected.json with an empty list', async () => {
    const sourceDir = copyFixture('marked');
    const stale = {
      generatedAt: '2000-01-01T00:00:00.000Z',
      rejected: [{ candidate: { name: 'Stale' }, reasons: [{ code: 'unlocated', detail: 'from an earlier run' }] }],
    };

    writeFileSync(seedRejectedPath(sourceDir), `${JSON.stringify(stale, null, 2)}\n`);

    await seed(sourceDir, stubSpawner(RECORDED_RESPONSE).spawn);

    expect(JSON.parse(readFileSync(seedRejectedPath(sourceDir), 'utf8')))
      .toStrictEqual({ generatedAt: NOW.toISOString(), rejected: [] });
  }, TEST_TIMEOUT_MS);

  test('a name marked on several pages is taken from the first kept page by path, the rest ignored', async () => {
    const sourceDir = copyFixture('marked');

    writeFileSync(
      join(sourceDir, 'extra.html'),
      '<!doctype html><html lang="en"><body><span data-component="Icon" data-level="particle">*</span></body></html>\n',
    );
    writeDiscovery(sourceDir, discover(sourceDir));

    const result = await seed(sourceDir, stubSpawner(RECORDED_RESPONSE).spawn);
    const icons = result.manifest.components.filter((entry) => entry.name === 'Icon');

    expect(icons.map((entry) => entry.page)).toStrictEqual(['extra.html']);
    expect(result.rejected).toStrictEqual([]);
  }, TEST_TIMEOUT_MS);
});

describe('runSeed over the unmarked fixture', () => {
  test('calls the spawner once over both pages and writes the accepted and rejected entries', async () => {
    const sourceDir = copyFixture('unmarked');
    const stub = stubSpawner(RECORDED_RESPONSE);

    const result = await seed(sourceDir, stub.spawn);

    expect(stub.prompts).toHaveLength(1);
    expect(stub.prompts[0]).toContain('### "gallery.html"');
    expect(stub.prompts[0]).toContain('### "index.html"');
    expect(result.agentRan).toBe(true);
    expect(result.manifest.components.map((entry) => entry.name))
      .toStrictEqual(['CardTitle', 'Button', 'Card', 'Menu', 'Promo']);
    expect(result.manifest.components.every((entry) => entry.origin === 'agent')).toBe(true);
    expect(result.rejected.map((rejected) => candidateName(rejected.candidate)).sort())
      .toStrictEqual(['FilterButton', 'Footer', 'GalleryCard', 'GalleryPromo', 'SearchBar']);
    expect(readSeedManifest(sourceDir)).toStrictEqual(result.manifest);
    expect(JSON.parse(readFileSync(seedRejectedPath(sourceDir), 'utf8')))
      .toStrictEqual({ generatedAt: NOW.toISOString(), rejected: result.rejected });
  }, TEST_TIMEOUT_MS);

  test('a run with no accepted entry is refused with its rejections and both files unwritten', async () => {
    const sourceDir = copyFixture('unmarked');
    const onlyBad = JSON.stringify({
      components: [{
        name: 'GalleryCard',
        level: 'molecule',
        page: 'gallery.html',
        selector: '.card',
        examples: [],
        states: [],
        variantAxes: {},
        parts: [],
        docText: [],
      }],
    });
    const stub = stubSpawner(onlyBad);
    const refusal = await seed(sourceDir, stub.spawn).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(SeedRefusedError);
    expect((refusal as SeedRefusedError).message).toContain('no component entry was accepted');
    expect((refusal as SeedRefusedError).rejected.map((rejected) => rejected.reasons.map((reason) => reason.code)))
      .toStrictEqual([['selector-multi-match']]);
    expect(stub.prompts).toHaveLength(1);
    expect(existsSync(seedManifestPath(sourceDir))).toBe(false);
    expect(existsSync(seedRejectedPath(sourceDir))).toBe(false);
  }, TEST_TIMEOUT_MS);
});
