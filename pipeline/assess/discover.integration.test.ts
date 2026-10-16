/**
 * Integration tests for {@link discover} and {@link writeDiscovery} run over
 * the three fixture exports as whole trees, end to end: walk, pages,
 * resources and schema validation together, followed by an actual write to
 * disk.
 *
 * Fixtures are tracked and must not be mutated, so every test copies the
 * fixture it exercises into a fresh temporary directory first.
 *
 * @packageDocumentation
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from './discover.ts';
import { discoveryReportSchema } from './schema.ts';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

const FIXTURES = ['with-ds', 'without-ds', 'nested'] as const;

const NOW = new Date('2026-09-30T12:00:00.000Z');

const LATER = new Date('2026-10-01T08:30:00.000Z');

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-assess-discover-integration-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Copies a tracked fixture export into a fresh subdirectory of `workDir`. */
function copyFixture(name: (typeof FIXTURES)[number]): string {
  const target = join(workDir, name);

  cpSync(join(FIXTURES_DIR, name), target, { recursive: true });

  return target;
}

/** Places `content` at a POSIX path under `sourceDir`, creating parents. */
function place(sourceDir: string, relativePath: string, content: string): void {
  const filePath = join(sourceDir, ...relativePath.split('/'));

  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

describe('discover and writeDiscovery over the fixture exports', () => {
  test.each(FIXTURES)('writes a discovery.json for %s that validates against the schema', (name) => {
    const sourceDir = copyFixture(name);

    const written = writeDiscovery(sourceDir, discover(sourceDir, { now: NOW }));
    const onDisk = JSON.parse(readFileSync(join(sourceDir, 'discovery.json'), 'utf8'));

    expect(discoveryReportSchema.safeParse(onDisk).success).toBe(true);
    expect(onDisk).toEqual(written);
  });

  test('lists every nested page, sorted by path, for the nested fixture', () => {
    const sourceDir = copyFixture('nested');

    const report = discover(sourceDir, { now: NOW });

    expect(report.pages.map((page) => page.path)).toEqual([
      'screens/app/dashboard.html',
      'screens/marketing/home.html',
    ]);
  });

  test('keeps the three-script order of the with-ds landing-v2 page', () => {
    const sourceDir = copyFixture('with-ds');

    const report = discover(sourceDir, { now: NOW });
    const landingV2 = report.pages.find((page) => page.path === 'landing-v2.dc.html');

    expect(landingV2?.scripts).toEqual([
      { src: 'support.js', type: null },
      { src: 'https://unpkg.com/react@18.3.1/umd/react.development.js', type: null },
      { inline: true, type: 'text/babel' },
    ]);
  });

  test('gives a one-page report for a single-page export', () => {
    const sourceDir = join(workDir, 'single-page');

    mkdirSync(sourceDir, { recursive: true });
    place(sourceDir, 'index.html', '<!doctype html><html><head><title>Only Page</title></head><body></body></html>');

    const report = discover(sourceDir, { now: NOW });

    expect(report.pages).toHaveLength(1);
    expect(report.pages[0]?.path).toBe('index.html');
  });

  test.each(FIXTURES)('gives two runs over %s the same report apart from generatedAt', (name) => {
    const sourceDir = copyFixture(name);

    const first = discover(sourceDir, { now: NOW });
    const second = discover(sourceDir, { now: LATER });

    expect(second.generatedAt).not.toBe(first.generatedAt);
    expect({ ...second, generatedAt: first.generatedAt }).toEqual(first);
  });
});
