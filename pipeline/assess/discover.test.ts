import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { discover, discoveryPath, writeDiscovery } from './discover.ts';
import { AssessRefusedError } from './errors.ts';
import { discoveryReportSchema, KNOWN_FILE_NAMES } from './schema.ts';

const NOW = new Date('2026-09-30T12:00:00.000Z');

const LATER = new Date('2026-10-01T08:30:00.000Z');

const PAGE = [
  '<!doctype html><html><head><title>Home</title>',
  '<link rel="stylesheet" href="theme.css">',
  '<script src="support.js"></script><script type="module">run()</script>',
  '</head><body><div data-component="card"></div></body></html>',
].join('');

let sourceDir: string;

/** Writes `content` at a POSIX path under the temporary source dir. */
function place(relativePath: string, content: string): void {
  const filePath = join(sourceDir, ...relativePath.split('/'));

  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

function placeExport(): void {
  place('index.html', PAGE);
  place('theme.css', ':root { --brand: red; --ink: black; }');
  place('support.js', 'export {};');
  place('system/variants.ts', 'export {};');
  place('img/logo.png', 'png');
}

function readWritten(): unknown {
  return JSON.parse(readFileSync(join(sourceDir, 'discovery.json'), 'utf8'));
}

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-assess-discover-test-'));
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
});

describe('discover', () => {
  test('assembles every script-owned field from one walk of the tree', () => {
    placeExport();

    const report = discover(sourceDir, { now: NOW });

    expect(report.pages).toEqual([
      {
        path: 'index.html',
        title: 'Home',
        scripts: [{ src: 'support.js', type: null }, { inline: true, type: 'module' }],
        stylesheets: [{ href: 'theme.css' }],
        markers: { 'data-component': 1 },
      },
    ]);
    expect(report.tokens).toEqual([{ path: 'theme.css', customPropertyCount: 2 }]);
    expect(report.variantMaps).toEqual([{ path: 'system/variants.ts' }]);
    expect(report.assets).toEqual({
      images: ['img/logo.png'],
      fonts: [],
      styles: ['theme.css'],
      scripts: ['support.js', 'system/variants.ts'],
      other: ['index.html'],
    });
    expect(report.knownFiles.map((file) => [file.name, file.status])).toEqual([
      ['_adherence.oxlintrc.json', 'absent'],
      ['_ds_manifest.json', 'absent'],
      ['support.js', 'found'],
      ['tokens.ts', 'absent'],
      ['variants.ts', 'found'],
    ]);
  });

  test('stamps generatedAt from now and leaves agentNotes empty', () => {
    placeExport();

    const report = discover(sourceDir, { now: NOW });

    expect(report.generatedAt).toBe('2026-09-30T12:00:00.000Z');
    expect(report.agentNotes).toEqual({ pageRoles: {}, versionGroups: [], boundaryHints: [] });
  });

  test('defaults generatedAt to the current time', () => {
    const before = Date.now();
    const report = discover(sourceDir);
    const stamped = Date.parse(report.generatedAt);

    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  test('returns a report that validates against the whole-file schema', () => {
    placeExport();

    expect(discoveryReportSchema.safeParse(discover(sourceDir, { now: NOW })).success).toBe(true);
  });

  test('reports an empty source dir with no pages and every known file absent', () => {
    const report = discover(sourceDir, { now: NOW });

    expect(report.pages).toEqual([]);
    expect(report.tokens).toEqual([]);
    expect(report.knownFiles).toEqual(KNOWN_FILE_NAMES.map((name) => ({ name, status: 'absent', paths: [] })));
  });

  test('does not read the import record or an earlier discovery.json', () => {
    placeExport();
    const withoutPipelineFiles = discover(sourceDir, { now: NOW });

    place('.import/record.json', '{}');
    place('discovery.json', '{}');

    expect(discover(sourceDir, { now: NOW })).toEqual(withoutPipelineFiles);
  });

  test('gives the same report for the same tree apart from generatedAt', () => {
    placeExport();

    const first = discover(sourceDir, { now: NOW });
    const second = discover(sourceDir, { now: LATER });

    expect({ ...second, generatedAt: first.generatedAt }).toEqual(first);
    expect(second.generatedAt).not.toBe(first.generatedAt);
  });

  test('throws when the source dir does not exist', () => {
    expect(() => discover(join(sourceDir, 'missing'), { now: NOW })).toThrow(/ENOENT/);
  });

  test('lets a missing source dir\'s ENOENT through as the system error, not a refusal', () => {
    const missing = join(sourceDir, 'missing');

    expect(() => discover(missing, { now: NOW })).toThrow(expect.objectContaining({ code: 'ENOENT', path: missing }));
    expect(() => discover(missing, { now: NOW })).not.toThrow(AssessRefusedError);
  });

  test('refuses a symlink in the export with an AssessRefusedError naming it', () => {
    placeExport();
    symlinkSync(join(sourceDir, 'index.html'), join(sourceDir, 'img', 'linked.html'));

    expect(() => discover(sourceDir, { now: NOW })).toThrow(AssessRefusedError);
    expect(() => discover(sourceDir, { now: NOW })).toThrow(expect.objectContaining({ path: 'img/linked.html' }));
  });
});

describe('discoveryPath', () => {
  test('is discovery.json directly inside the resolved source dir', () => {
    expect(discoveryPath(sourceDir)).toBe(join(sourceDir, 'discovery.json'));
  });

  describe('with a report file name that leaves the source dir', () => {
    test.each(['../discovery.json', '.'])('refuses %s with an AssessRefusedError naming the resolved path', (name) => {
      const target = join(sourceDir, name);

      expect(() => discoveryPath(sourceDir, name)).toThrow(AssessRefusedError);
      expect(() => discoveryPath(sourceDir, name)).toThrow(expect.objectContaining({ path: target }));
      expect(() => discoveryPath(sourceDir, name)).toThrow(`${target} does not resolve inside ${sourceDir}`);
    });
  });
});

describe('writeDiscovery', () => {
  test('writes the report to <sourceDir>/discovery.json as indented JSON', () => {
    placeExport();
    const report = discover(sourceDir, { now: NOW });

    const written = writeDiscovery(sourceDir, report);
    const text = readFileSync(join(sourceDir, 'discovery.json'), 'utf8');

    expect(written).toEqual(report);
    expect(text).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(discoveryReportSchema.parse(readWritten())).toEqual(report);
  });

  test('replaces an earlier report', () => {
    writeDiscovery(sourceDir, discover(sourceDir, { now: NOW }));
    placeExport();

    writeDiscovery(sourceDir, discover(sourceDir, { now: LATER }));

    expect(readWritten()).toMatchObject({ generatedAt: '2026-10-01T08:30:00.000Z', pages: [{ path: 'index.html' }] });
  });

  test('refuses a report that fails the schema and writes nothing', () => {
    const report = discover(sourceDir, { now: NOW });
    const unsorted = { ...report, variantMaps: [{ path: 'b/variants.ts' }, { path: 'a/variants.ts' }] };

    expect(() => writeDiscovery(sourceDir, unsorted)).toThrow(/sorted/);
    expect(existsSync(join(sourceDir, 'discovery.json'))).toBe(false);
  });

  test('keeps agent notes a valid report carries', () => {
    place('index.html', PAGE);
    const report = {
      ...discover(sourceDir, { now: NOW }),
      agentNotes: {
        pageRoles: { 'index.html': { role: 'demo' as const, reason: 'shows every component' } },
        versionGroups: [],
        boundaryHints: [],
      },
    };

    writeDiscovery(sourceDir, report);

    expect(readWritten()).toMatchObject({ agentNotes: report.agentNotes });
  });
});
