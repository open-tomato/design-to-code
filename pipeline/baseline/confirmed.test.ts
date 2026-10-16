import type { ConfirmedEntry } from './confirmed.ts';

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  CONFIRMED_FILE,
  ConfirmedFileError,
  confirmedPath,
  readConfirmed,
  recordConfirmation,
  unconfirmedPages,
  writeConfirmed,
} from './confirmed.ts';

const HASH_A = 'a'.repeat(64);

const HASH_B = 'b'.repeat(64);

const AT = '2026-09-30T12:00:00.000Z';

const LATER = '2026-09-30T13:00:00.000Z';

let baselineDir: string;

beforeEach(() => {
  baselineDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-baseline-confirmed-test-'));
});

afterEach(() => {
  rmSync(baselineDir, { recursive: true, force: true });
});

function personEntry(page: string, importHash: string, confirmedAt = AT): ConfirmedEntry {
  return { page, confirmedAt, by: 'person', importHash };
}

describe('readConfirmed', () => {
  test('reads a missing file as no confirmations', () => {
    expect(existsSync(confirmedPath(baselineDir))).toBe(false);

    expect(readConfirmed(baselineDir)).toEqual([]);
  });

  test('reads a missing baseline dir as no confirmations', () => {
    expect(readConfirmed(join(baselineDir, 'absent'))).toEqual([]);
  });

  test('reads back what the writer wrote', () => {
    const entries: readonly ConfirmedEntry[] = [
      personEntry('index.html', HASH_A),
      { page: 'about us/team.html', confirmedAt: AT, by: 'share-link', importHash: HASH_A, score: 0.004 },
    ];

    writeConfirmed(baselineDir, entries);

    expect(readConfirmed(baselineDir)).toEqual([entries[1], entries[0]]);
  });

  test('refuses a file that is not JSON, naming its path', () => {
    writeFileSync(confirmedPath(baselineDir), '[{"page":');

    expect(() => readConfirmed(baselineDir)).toThrow(ConfirmedFileError);
    expect(() => readConfirmed(baselineDir)).toThrow(confirmedPath(baselineDir));
  });

  test('refuses a file that fails the schema, naming its path and the field', () => {
    writeFileSync(confirmedPath(baselineDir), JSON.stringify([{ page: 'index.html', by: 'robot' }]));

    expect(() => readConfirmed(baselineDir)).toThrow(ConfirmedFileError);
    expect(() => readConfirmed(baselineDir)).toThrow(confirmedPath(baselineDir));
    expect(() => readConfirmed(baselineDir)).toThrow('0.by');
  });

  test('refuses a file listing a page twice', () => {
    writeFileSync(
      confirmedPath(baselineDir),
      JSON.stringify([personEntry('index.html', HASH_A), personEntry('index.html', HASH_B)]),
    );

    expect(() => readConfirmed(baselineDir)).toThrow('listed twice');
  });

  test('refuses a score on a person entry', () => {
    writeFileSync(confirmedPath(baselineDir), JSON.stringify([{ ...personEntry('index.html', HASH_A), score: 0 }]));

    expect(() => readConfirmed(baselineDir)).toThrow(ConfirmedFileError);
  });
});

describe('writeConfirmed', () => {
  test('writes one entry per page sorted by page, as 2-space JSON with a trailing newline', () => {
    writeConfirmed(baselineDir, [personEntry('z.html', HASH_A), personEntry('a b/c.html', HASH_A)]);
    const text = readFileSync(join(baselineDir, CONFIRMED_FILE), 'utf8');

    expect(text).toBe(`${JSON.stringify([personEntry('a b/c.html', HASH_A), personEntry('z.html', HASH_A)], null, 2)}\n`);
  });

  test('leaves no temporary file behind', () => {
    writeConfirmed(baselineDir, [personEntry('index.html', HASH_A)]);

    expect(readdirSync(baselineDir)).toEqual([CONFIRMED_FILE]);
  });

  test('creates a missing baseline dir', () => {
    const nested = join(baselineDir, 'baselines', 'demo');

    writeConfirmed(nested, [personEntry('index.html', HASH_A)]);

    expect(readConfirmed(nested)).toEqual([personEntry('index.html', HASH_A)]);
  });

  test('refuses a page listed twice and writes nothing', () => {
    expect(() => writeConfirmed(baselineDir, [personEntry('index.html', HASH_A), personEntry('index.html', HASH_B)]))
      .toThrow(ConfirmedFileError);
    expect(readdirSync(baselineDir)).toEqual([]);
  });
});

describe('recordConfirmation', () => {
  test('re-confirming a page replaces its entry', () => {
    recordConfirmation(baselineDir, personEntry('index.html', HASH_A));
    recordConfirmation(baselineDir, personEntry('other.html', HASH_A));

    const written = recordConfirmation(baselineDir, personEntry('index.html', HASH_B, LATER));

    expect(written).toEqual([personEntry('index.html', HASH_B, LATER), personEntry('other.html', HASH_A)]);
    expect(readConfirmed(baselineDir)).toEqual(written);
  });

  test('refuses to overwrite a malformed file', () => {
    writeFileSync(confirmedPath(baselineDir), 'not json');

    expect(() => recordConfirmation(baselineDir, personEntry('index.html', HASH_A))).toThrow(confirmedPath(baselineDir));
    expect(readFileSync(confirmedPath(baselineDir), 'utf8')).toBe('not json');
  });
});

describe('unconfirmedPages', () => {
  test('lists a kept page with no entry', () => {
    expect(unconfirmedPages(['a.html', 'b.html'], [personEntry('a.html', HASH_A)], HASH_A)).toEqual(['b.html']);
  });

  test('lists a page whose entry is under another import hash', () => {
    const confirmed = [personEntry('a.html', HASH_B), personEntry('b.html', HASH_A)];

    expect(unconfirmedPages(['a.html', 'b.html'], confirmed, HASH_A)).toEqual(['a.html']);
  });

  test('lists nothing when every kept page is confirmed under the hash', () => {
    const confirmed = [personEntry('a.html', HASH_A), personEntry('b.html', HASH_A), personEntry('gone.html', HASH_A)];

    expect(unconfirmedPages(['a.html', 'b.html'], confirmed, HASH_A)).toEqual([]);
  });
});
