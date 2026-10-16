/**
 * Discovery: the whole deterministic assess pass over a project's source
 * dir, and the writing of its report to `<source.dir>/discovery.json`.
 *
 * {@link discover} walks the source dir once ({@link walkSourceDir}), reads
 * its pages ({@link discoverPages}), token files, variant maps, asset groups
 * and known files (`resources.ts`), stamps `generatedAt`, adds empty
 * `agentNotes` ({@link emptyAgentNotes}) and validates the whole report
 * against {@link discoveryReportSchema}. {@link writeDiscovery} validates a
 * report again and writes it as indented JSON.
 *
 * The same export always gives the same report, byte for byte, apart from
 * `generatedAt`. Nothing here is required of an export: a known file that
 * is missing is reported absent, never an error.
 *
 * @packageDocumentation
 */

import type { DiscoveryReport } from './schema.ts';

import { writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { AssessRefusedError } from './errors.ts';
import { discoverPages } from './pages.ts';
import { discoverKnownFiles, discoverTokens, discoverVariantMaps, groupAssets } from './resources.ts';
import { discoveryReportSchema, emptyAgentNotes } from './schema.ts';
import { DISCOVERY_FILE, walkSourceDir } from './walk.ts';

/** Options for {@link discover}. */
export interface DiscoverOptions {
  /** The moment stamped as `generatedAt`; the current time by default. */
  readonly now?: Date;
}

/**
 * The absolute path of the discovery report for a source dir, proven to
 * resolve inside it.
 *
 * @param sourceDir - The source dir the report belongs in.
 * @param fileName - The report's file name, resolved against `sourceDir`;
 * {@link DISCOVERY_FILE} by default. Every caller but a test of the
 * refusal leaves it at that default.
 * @throws AssessRefusedError when the report path does not resolve inside
 * `sourceDir`; its `path` is the report's absolute path.
 */
export function discoveryPath(sourceDir: string, fileName: string = DISCOVERY_FILE): string {
  const root = resolve(sourceDir);
  const target = resolve(root, fileName);
  const fromRoot = relative(root, target);

  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new AssessRefusedError(target, `${target} does not resolve inside ${root}`);
  }

  return target;
}

/**
 * Assesses the export under `sourceDir` and returns its discovery report,
 * with `agentNotes` empty.
 *
 * The top-level `.import/` directory and any earlier `discovery.json` are
 * not part of the export and are not read.
 *
 * @param sourceDir - The project's source dir.
 * @throws AssessRefusedError when the tree holds an entry that is neither a
 * regular file nor a directory, such as a symlink.
 * @throws Error the system error (`ENOENT`, `EACCES`, ...) when the tree
 * cannot be read, such as a `sourceDir` that does not exist.
 * @throws `ZodError` when the assembled report fails the schema.
 */
export function discover(sourceDir: string, options: DiscoverOptions = {}): DiscoveryReport {
  const { now = new Date() } = options;
  const paths = walkSourceDir(sourceDir);

  return discoveryReportSchema.parse({
    generatedAt: now.toISOString(),
    pages: discoverPages(sourceDir, paths),
    tokens: discoverTokens(sourceDir, paths),
    variantMaps: discoverVariantMaps(paths),
    assets: groupAssets(paths),
    knownFiles: discoverKnownFiles(paths),
    agentNotes: emptyAgentNotes(),
  });
}

/**
 * Validates `report` against {@link discoveryReportSchema} and writes it to
 * `<sourceDir>/discovery.json` as indented JSON with a trailing newline,
 * replacing any earlier report. Nothing is written when validation fails.
 *
 * @param sourceDir - The project's source dir; it must already exist.
 * @param report - The report to write, as {@link discover} returns it or
 * with agent notes merged in.
 * @returns The report as written.
 * @throws `ZodError` when `report` fails the schema.
 * @throws AssessRefusedError when the report path does not resolve inside
 * `sourceDir`.
 */
export function writeDiscovery(sourceDir: string, report: DiscoveryReport): DiscoveryReport {
  const validated = discoveryReportSchema.parse(report);

  writeFileSync(discoveryPath(sourceDir), `${JSON.stringify(validated, null, 2)}\n`);

  return validated;
}
