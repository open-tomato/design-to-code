/**
 * The merge of the assess agent's output into a script report: the control
 * that keeps the agent from overwriting what the discovery scripts found.
 *
 * {@link mergeAgentNotes} takes the report the scripts wrote and the
 * agent's parsed output, which must be a JSON object whose only key is
 * {@link AGENT_OUTPUT_KEY}. It refuses, with a {@link MergeRefusedError}
 * naming every offending field, any output that restates a script-owned
 * field (one of {@link SCRIPT_FIELDS} or `generatedAt`) — even with the
 * value the scripts wrote — or carries any other unknown top-level key, or
 * whose `agentNotes` fail {@link agentNotesSchema}.
 *
 * The merge is pure: it writes nothing, and it mutates neither argument.
 * A refusal therefore leaves `discovery.json` as the scripts wrote it.
 *
 * @packageDocumentation
 */

import type { DiscoveryReport } from './schema.ts';

import { agentNotesSchema, discoveryReportSchema, SCRIPT_FIELDS, scriptReportSchema } from './schema.ts';

/** The one top-level key the agent's output may carry. */
export const AGENT_OUTPUT_KEY = 'agentNotes';

/** Every top-level report key the scripts own, `generatedAt` included. */
const SCRIPT_OWNED_KEYS: readonly string[] = [...SCRIPT_FIELDS, 'generatedAt'];

/**
 * Agent output the merge refuses. The message names each offending field;
 * `fields` lists them, dotted from the output's root, `''` for the root.
 */
export class MergeRefusedError extends Error {
  override readonly name = 'MergeRefusedError';

  /** The offending fields, in the order the message names them. */
  readonly fields: readonly string[];

  constructor(fields: readonly string[], message: string) {
    super(`agent output refused: ${message}`);
    this.fields = fields;
  }
}

/** True when `value` is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Throws when `output` carries a top-level key other than
 * {@link AGENT_OUTPUT_KEY}: script-owned keys first, then unknown ones,
 * each group sorted by code unit.
 */
function refuseForeignKeys(output: Record<string, unknown>): void {
  const foreign = Object.keys(output).filter((key) => key !== AGENT_OUTPUT_KEY);
  const scriptOwned = foreign.filter((key) => SCRIPT_OWNED_KEYS.includes(key)).sort();
  const unknown = foreign.filter((key) => !SCRIPT_OWNED_KEYS.includes(key)).sort();

  if (scriptOwned.length === 0 && unknown.length === 0) {
    return;
  }

  const reasons = [
    ...scriptOwned.map((key) => `touches script-owned field ${key}`),
    ...unknown.map((key) => `carries unknown top-level key ${key}`),
  ];

  throw new MergeRefusedError([...scriptOwned, ...unknown], reasons.join('; '));
}

/**
 * Merges the agent's parsed output into `report`, replacing its
 * `agentNotes`, and returns a new, validated discovery report whose
 * script-owned fields equal the report's.
 *
 * @param report - The report the scripts wrote, with or without
 * `agentNotes`; any `agentNotes` it carries are replaced, not merged into.
 * @param output - The agent's output, parsed from JSON: `{ agentNotes }`.
 * @throws MergeRefusedError when `output` is not an object, carries a key
 * other than `agentNotes`, lacks `agentNotes`, or its `agentNotes` fail
 * the schema.
 * @throws ZodError when `report`'s script-owned fields fail the schema.
 */
export function mergeAgentNotes(report: unknown, output: unknown): DiscoveryReport {
  const scriptFields = isPlainObject(report)
    ? Object.fromEntries(Object.entries(report).filter(([key]) => key !== AGENT_OUTPUT_KEY))
    : report;
  const scriptReport = scriptReportSchema.parse(scriptFields);

  if (!isPlainObject(output)) {
    throw new MergeRefusedError([''], 'must be a JSON object holding only agentNotes');
  }

  refuseForeignKeys(output);

  if (!Object.hasOwn(output, AGENT_OUTPUT_KEY)) {
    throw new MergeRefusedError([AGENT_OUTPUT_KEY], `is missing ${AGENT_OUTPUT_KEY}`);
  }

  const notes = agentNotesSchema.safeParse(output[AGENT_OUTPUT_KEY]);

  if (!notes.success) {
    const fields = notes.error.issues.map((issue) => [AGENT_OUTPUT_KEY, ...issue.path.map(String)].join('.'));
    const reasons = notes.error.issues.map((issue, index) => `${fields[index]}: ${issue.message}`);

    throw new MergeRefusedError(fields, reasons.join('; '));
  }

  return discoveryReportSchema.parse({ ...scriptReport, agentNotes: notes.data });
}
