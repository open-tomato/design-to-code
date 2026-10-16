/**
 * The running server's record, `<source.dir>/.serve.json`: the address a
 * serve run answers on, so other steps can find it.
 *
 * The record sits at the top level of `source.dir`, like `discovery.json`,
 * and the assess walk skips it ({@link SERVE_FILE}), so serving never
 * changes what discovery reports. Every path into `source.dir` that the
 * serve verb writes goes through {@link sourceDirFile}, which proves the
 * resolved path lies inside it.
 *
 * @packageDocumentation
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { SERVE_FILE } from '../assess/walk.ts';

/** What `.serve.json` holds. */
export interface ServeRecord {
  /** The server's base URL, such as `http://127.0.0.1:4600/`. */
  readonly address: string;
  /** The port the server is bound to. */
  readonly port: number;
  /** The id of the process running the server. */
  readonly pid: number;
  /** When the server started, as an ISO 8601 timestamp. */
  readonly startedAt: string;
}

/**
 * The absolute path of `fileName` at the top level of `sourceDir`, proven
 * to resolve inside it.
 *
 * @throws Error when the path resolves to `sourceDir` itself or outside it.
 */
export function sourceDirFile(sourceDir: string, fileName: string): string {
  const root = resolve(sourceDir);
  const target = resolve(root, fileName);
  const fromRoot = relative(root, target);

  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${target} does not resolve inside ${root}`);
  }

  return target;
}

/** The absolute path of `<sourceDir>/.serve.json`. */
export function serveRecordPath(sourceDir: string): string {
  return sourceDirFile(sourceDir, SERVE_FILE);
}

/**
 * Writes `record` to `<sourceDir>/.serve.json` as indented JSON with a
 * trailing newline, replacing any earlier record.
 */
export function writeServeRecord(sourceDir: string, record: ServeRecord): void {
  writeFileSync(serveRecordPath(sourceDir), `${JSON.stringify(record, null, 2)}\n`);
}

/** Whether the file at `filePath` is a record naming `record`'s port and pid. */
function namesServer(filePath: string, record: ServeRecord): boolean {
  let written: unknown;

  try {
    written = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }

  const { port, pid } = (written ?? {}) as Partial<ServeRecord>;

  return port === record.port && pid === record.pid;
}

/**
 * Removes `<sourceDir>/.serve.json` when it still names `record`'s port and
 * pid. A record another server wrote over it since, or none at all, is left
 * as it is, so stopping one server never hides another one's address.
 *
 * @returns Whether the record was removed.
 */
export function removeServeRecord(sourceDir: string, record: ServeRecord): boolean {
  const filePath = serveRecordPath(sourceDir);

  if (!namesServer(filePath, record)) {
    return false;
  }

  rmSync(filePath, { force: true });

  return true;
}
