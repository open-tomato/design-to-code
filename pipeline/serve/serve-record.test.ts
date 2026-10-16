import type { ServeRecord } from './serve-record.ts';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  removeServeRecord,
  serveRecordPath,
  sourceDirFile,
  writeServeRecord,
} from './serve-record.ts';

const RECORD: ServeRecord = {
  address: 'http://127.0.0.1:5123/',
  port: 5123,
  pid: 4242,
  startedAt: '2026-09-30T12:00:00.000Z',
};

let workDir: string;
let sourceDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-serve-serve-record-test-'));
  sourceDir = join(workDir, 'source');
  mkdirSync(sourceDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('sourceDirFile', () => {
  test('resolves a top-level name inside the source dir', () => {
    expect(sourceDirFile(sourceDir, 'serve-check.json')).toBe(join(sourceDir, 'serve-check.json'));
  });

  test.each(['../outside.json', '.', '', '/etc/passwd'])('refuses "%s", which does not resolve inside it', (name) => {
    expect(() => sourceDirFile(sourceDir, name)).toThrow('does not resolve inside');
  });
});

describe('serve record', () => {
  test('lives at the top level of the source dir', () => {
    expect(serveRecordPath(sourceDir)).toBe(join(sourceDir, '.serve.json'));
  });

  test('is written as indented JSON with a trailing newline', () => {
    writeServeRecord(sourceDir, RECORD);

    expect(readFileSync(join(sourceDir, '.serve.json'), 'utf8')).toBe(`${JSON.stringify(RECORD, null, 2)}\n`);
  });

  test('is removed when it still names the server', () => {
    writeServeRecord(sourceDir, RECORD);

    expect(removeServeRecord(sourceDir, RECORD)).toBe(true);
    expect(existsSync(join(sourceDir, '.serve.json'))).toBe(false);
  });

  test.each([
    ['another port', { ...RECORD, port: 5124, address: 'http://127.0.0.1:5124/' }],
    ['another process', { ...RECORD, pid: 4343 }],
  ])('is left in place when it names %s', (_, other) => {
    writeServeRecord(sourceDir, other);

    expect(removeServeRecord(sourceDir, RECORD)).toBe(false);
    expect(JSON.parse(readFileSync(join(sourceDir, '.serve.json'), 'utf8'))).toEqual(other);
  });

  test('removing a record that is not there is a no-op', () => {
    expect(removeServeRecord(sourceDir, RECORD)).toBe(false);
  });
});
