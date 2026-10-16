/**
 * One gate's result for one component, and where it is written:
 * `<target.dir>/gate-results/<component>/<gate>.json`.
 *
 * A result names its `gate` (one of {@link GATE_NAMES}), the `component`
 * it judged, its `status` (one of {@link GATE_STATUSES}), its `findings`
 * and its `durationMs`. A finding names the `rule` it broke, the `file`
 * (POSIX-relative to `target.dir`) and 1-based `line` it points at, each
 * `null` when the finding has no place, and a `message` for the reader.
 *
 * A `fail` carries at least one finding, so a reader always learns why, and
 * a `pass` carries none. A `record-only` result is free either way. The
 * `component` is one path segment, since it names a folder; findings that
 * belong to no component go under {@link LIBRARY_COMPONENT}.
 *
 * This module knows gate names only as a string enum; what each gate checks
 * is each gate's own business. The TypeScript types are inferred from the
 * schemas, never written by hand.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

/** The gate names, as written in results and result file names. */
export const GATE_NAMES = ['structure', 'state-coverage', 'build-lint', 'story-health'] as const;

/** A gate's verdict: it passed, it failed, or it only records a reading. */
export const GATE_STATUSES = ['pass', 'fail', 'record-only'] as const;

/** The pseudo-component holding findings that belong to no component. */
export const LIBRARY_COMPONENT = '_library';

/** The rule of the finding every gate reports when it scanned zero files. */
export const SCANNED_ZERO_FILES_RULE = 'scanned-zero-files';

/** The folder under `target.dir` that holds every gate result. */
export const GATE_RESULTS_DIR = 'gate-results';

/** A gate name. */
export type GateName = (typeof GATE_NAMES)[number];

/** A gate's verdict. */
export type GateStatus = (typeof GATE_STATUSES)[number];

const nonEmptyString = z.string().min(1);

/** A path POSIX-relative to `target.dir`: no leading `/`, no backslash, no empty, `.` or `..` segment. */
const targetRelativePath = z.string().refine(
  (path) => !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  { error: 'must be a POSIX path relative to the target dir' },
);

/** A component name usable as one folder name: non-empty, no separator, not `.` or `..`. */
const componentName = z.string().refine(
  (name) => name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'),
  { error: 'must be a single path segment' },
);

/** One thing a gate found wrong: the rule, where it is, and what to do. */
export const gateFindingSchema = z.strictObject({
  rule: nonEmptyString,
  file: targetRelativePath.nullable(),
  line: z
    .int()
    .min(1)
    .nullable(),
  message: nonEmptyString,
});

/** One gate's result for one component. */
export const gateResultSchema = z
  .strictObject({
    gate: z.enum(GATE_NAMES),
    component: componentName,
    status: z.enum(GATE_STATUSES),
    findings: z.array(gateFindingSchema).readonly(),
    durationMs: z
      .number()
      .nonnegative()
      .refine(Number.isFinite, { error: 'must be finite' }),
  })
  .refine((result) => result.status !== 'fail' || result.findings.length > 0, {
    error: 'a failing result must carry at least one finding',
    path: ['findings'],
  })
  .refine((result) => result.status !== 'pass' || result.findings.length === 0, {
    error: 'a passing result must carry no findings',
    path: ['findings'],
  });

/** One thing a gate found wrong. */
export type GateFinding = z.infer<typeof gateFindingSchema>;

/** One gate's result for one component. */
export type GateResult = z.infer<typeof gateResultSchema>;

/**
 * The finding a gate reports when it scanned zero files, so an empty glob
 * reads as a failure instead of a pass. `scanned` says where the gate looked,
 * such as `src`; it goes in the message, and the finding has no file or line.
 */
export function scannedZeroFilesFinding(scanned: string): GateFinding {
  return {
    rule: SCANNED_ZERO_FILES_RULE,
    file: null,
    line: null,
    message: `scanned zero files in ${scanned}`,
  };
}

/**
 * The absolute path of `<targetDir>/gate-results/<component>/<gate>.json`.
 *
 * @throws z.ZodError when `component` is not a single path segment.
 */
export function gateResultPath(targetDir: string, component: string, gate: GateName): string {
  const root = resolve(targetDir, GATE_RESULTS_DIR);
  const target = join(root, componentName.parse(component), `${gate}.json`);
  const fromRoot = relative(root, target);

  if (fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${target} does not resolve inside ${root}`);
  }

  return target;
}

/**
 * Validates `result` and writes it to
 * `<targetDir>/gate-results/<component>/<gate>.json` as 2-space JSON with a
 * trailing newline, creating the folders it needs and replacing any earlier
 * file for that component and gate. The write goes through a temp file and
 * a rename, so a reader never sees a half-written result.
 *
 * @returns the absolute path written.
 * @throws z.ZodError when `result` fails the schema; nothing is written.
 */
export function writeGateResult(targetDir: string, result: GateResult): string {
  const parsed = gateResultSchema.parse(result);
  const target = gateResultPath(targetDir, parsed.component, parsed.gate);
  const temp = `${target}.${randomUUID()}.tmp`;

  mkdirSync(resolve(target, '..'), { recursive: true });

  try {
    writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }

  return target;
}
