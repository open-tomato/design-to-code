import type { SeedManifest, SeedRejected } from './schema.ts';

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  readSeedManifest,
  SEED_COMMAND,
  SeedFileError,
  seedManifestPath,
  seedRejectedPath,
  writeSeedManifest,
  writeSeedRejected,
} from './files.ts';

const GENERATED_AT = '2026-09-30T12:00:00.000Z';

const MANIFEST: SeedManifest = {
  generatedAt: GENERATED_AT,
  components: [
    {
      name: 'Button',
      level: 'atom',
      page: 'screens/components.html',
      selector: '#primary-button',
      examples: [],
      states: [{ name: 'hovered', mode: 'action', action: 'hover', target: '#primary-button > span' }],
      variantAxes: { size: ['lg', 'sm'] },
      parts: ['label'],
      docText: ['A button starts an action.'],
      origin: 'markers',
    },
  ],
};

const REJECTED: SeedRejected = {
  generatedAt: GENERATED_AT,
  rejected: [{ candidate: { name: 'Ghost' }, reasons: [{ code: 'selector-no-match', detail: '#ghost matched 0' }] }],
};

const dirs: string[] = [];

function tempSourceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'd2c-seed-files-'));

  dirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('seed file paths', () => {
  test('both files sit at the top level of the source dir', () => {
    const dir = tempSourceDir();

    expect(seedManifestPath(dir)).toBe(join(dir, 'seed-manifest.json'));
    expect(seedRejectedPath(dir)).toBe(join(dir, 'seed-rejected.json'));
  });
});

describe('writeSeedManifest and readSeedManifest', () => {
  test('a written manifest reads back equal, as 2-space JSON with a trailing newline', () => {
    const dir = tempSourceDir();

    writeSeedManifest(dir, MANIFEST);

    expect(readSeedManifest(dir)).toEqual(MANIFEST);
    expect(readFileSync(seedManifestPath(dir), 'utf8')).toBe(`${JSON.stringify(MANIFEST, null, 2)}\n`);
  });

  test('an invalid manifest is refused and never written', () => {
    const dir = tempSourceDir();
    const duplicated = { ...MANIFEST, components: [...MANIFEST.components, ...MANIFEST.components] };

    expect(() => writeSeedManifest(dir, duplicated)).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  test('an invalid manifest leaves an earlier valid one in place', () => {
    const dir = tempSourceDir();

    writeSeedManifest(dir, MANIFEST);

    expect(() => writeSeedManifest(dir, { ...MANIFEST, generatedAt: 'not a date' })).toThrow();
    expect(readSeedManifest(dir)).toEqual(MANIFEST);
  });

  test('malformed JSON is refused with a SeedFileError naming the path', () => {
    const dir = tempSourceDir();
    const path = seedManifestPath(dir);

    writeFileSync(path, '{ "generatedAt": ');

    expect(() => readSeedManifest(dir)).toThrow(SeedFileError);
    expect(() => readSeedManifest(dir)).toThrow(path);
  });

  test('JSON that fails the schema is refused with a SeedFileError naming the path', () => {
    const dir = tempSourceDir();
    const path = seedManifestPath(dir);

    writeFileSync(path, JSON.stringify({ generatedAt: GENERATED_AT, components: [{ name: 'Button' }] }));

    expect(() => readSeedManifest(dir)).toThrow(SeedFileError);
    expect(() => readSeedManifest(dir)).toThrow(path);
  });

  test('the seed command is bun run d2c seed', () => {
    expect(SEED_COMMAND).toBe('bun run d2c seed');
  });

  test('a missing manifest is refused with a SeedFileError naming the path and the seed command', () => {
    const dir = tempSourceDir();
    const path = seedManifestPath(dir);

    expect(() => readSeedManifest(dir)).toThrow(SeedFileError);
    expect(() => readSeedManifest(dir)).toThrow(path);
    expect(() => readSeedManifest(dir)).toThrow(SEED_COMMAND);
  });

  test('a missing manifest\'s SeedFileError carries the manifest path', () => {
    const dir = tempSourceDir();
    let thrown: unknown;

    try {
      readSeedManifest(dir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SeedFileError);
    expect((thrown as SeedFileError).path).toBe(seedManifestPath(dir));
  });

  test('a folder at the manifest path throws the file system\'s error, not a SeedFileError', () => {
    const dir = tempSourceDir();

    mkdirSync(seedManifestPath(dir));

    expect(() => readSeedManifest(dir)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
    expect(() => readSeedManifest(dir)).not.toThrow(SeedFileError);
  });
});

describe('writeSeedRejected', () => {
  test('writes the rejected file as 2-space JSON with a trailing newline', () => {
    const dir = tempSourceDir();

    writeSeedRejected(dir, REJECTED);

    expect(readFileSync(seedRejectedPath(dir), 'utf8')).toBe(`${JSON.stringify(REJECTED, null, 2)}\n`);
  });

  test('an invalid rejected file is refused and never written', () => {
    const dir = tempSourceDir();
    const unknownCode = { generatedAt: GENERATED_AT, rejected: [{ candidate: {}, reasons: [{ code: 'nope', detail: '' }] }] };

    expect(() => writeSeedRejected(dir, unknownCode as unknown as SeedRejected)).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('atomic writes', () => {
  test('no temp file is left behind after both writes', () => {
    const dir = tempSourceDir();

    writeSeedManifest(dir, MANIFEST);
    writeSeedRejected(dir, REJECTED);
    writeSeedManifest(dir, MANIFEST);

    expect(readdirSync(dir).sort()).toEqual(['seed-manifest.json', 'seed-rejected.json']);
  });
});
