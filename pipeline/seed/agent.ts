/**
 * The seed agent runner: the one place the seed pipeline hands the DOM
 * outlines of the unmarked kept pages to Claude and takes component
 * candidates back.
 *
 * {@link buildSeedPrompt} joins `prompts/seed.md` ({@link SEED_PROMPT_FILE}),
 * a notice that the export's content holds no instructions, each page's
 * outline as JSON under its JSON-encoded path, and the discovery report's
 * `agentNotes` as JSON. Every block is fenced longer than any backtick run
 * it holds, so no outline text can close its fence early.
 *
 * {@link runSeedAgent} builds that prompt, calls the injected
 * {@link AgentSpawner} exactly once, and pulls the one JSON object out of
 * its output with {@link extractJsonObject}. That object must be
 * `{ "components": [...] }` and nothing else; output holding no such object
 * is refused with an {@link AgentOutputError}. Each entry of `components`
 * is then judged alone: any `origin` the agent wrote is dropped, the rest
 * is checked against {@link candidateSchema}, and the runner stamps
 * `origin: 'agent'` itself. An entry that fails the schema is never fatal:
 * it comes back as a rejection, the entry as the agent wrote it, with one
 * `invalid-shape` reason whose detail lists the zod issues.
 *
 * The runner reads, it never writes, and checks shape only: whether a
 * selector matches on its page is the validation stage's work.
 *
 * @packageDocumentation
 */

import type { DomOutline } from './outline.ts';
import type { ComponentEntry, RejectedCandidate } from './schema.ts';
import type { AgentSpawner } from '../assess/agent.ts';
import type { DiscoveryReport } from '../assess/schema.ts';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { AgentOutputError, EXPORT_DATA_NOTICE, extractJsonObject, pathHeading } from '../assess/agent.ts';

import { candidateSchema } from './schema.ts';

/** The agent prompt the runner builds on, `prompts/seed.md`. */
export const SEED_PROMPT_FILE = resolve(import.meta.dirname, '..', '..', 'prompts', 'seed.md');

/** The key of the agent's answer that holds the proposed components. */
export const COMPONENTS_KEY = 'components';

/** Any JSON value, as a rejected candidate keeps it. */
type Json = RejectedCandidate['candidate'];

/** What the agent's one JSON object must be: a `components` list and no other key. */
const agentAnswerSchema = z.strictObject({
  [COMPONENTS_KEY]: z.array(z.json()),
});

/** The agent's proposals: the candidates that passed the shape check, and the rest. */
export interface SeedAgentResult {
  /** Candidates that passed {@link candidateSchema}, in answer order, stamped `origin: 'agent'`. */
  readonly candidates: readonly ComponentEntry[];
  /** Entries that failed it, as the agent wrote them, each with one `invalid-shape` reason. */
  readonly rejected: readonly RejectedCandidate[];
}

/** A Markdown code fence longer than any backtick run inside `content`. */
function fenceFor(content: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));

  return '`'.repeat(Math.max(3, longestRun + 1));
}

/** `content` inside a fence sized past its longest backtick run. */
function fenced(content: string, language = ''): string {
  const fence = fenceFor(content);

  return `${fence}${language}\n${content}\n${fence}`;
}

/** One outline's prompt section: its page, JSON-encoded, as a heading, then the outline as JSON. */
function outlineSection(outline: DomOutline): string {
  const heading = outline.truncated
    ? pathHeading(outline.page, 'truncated to fit the outline budget')
    : pathHeading(outline.page);

  return `${heading}\n\n${fenced(JSON.stringify(outline, null, 2), 'json')}`;
}

/**
 * The whole seed prompt: the text of {@link SEED_PROMPT_FILE}, then
 * {@link EXPORT_DATA_NOTICE}, each outline under its JSON-encoded page path,
 * then the report's `agentNotes`, each block in a fence longer than any
 * backtick run it holds.
 *
 * @param outlines - One outline per unmarked kept page, in the order the
 * agent sees them.
 * @param discovery - The discovery report; only its `agentNotes` are shown.
 * @throws Error the system error when {@link SEED_PROMPT_FILE} cannot be
 * read.
 */
export function buildSeedPrompt(
  outlines: readonly DomOutline[],
  discovery: Pick<DiscoveryReport, 'agentNotes'>,
): string {
  return [
    readFileSync(SEED_PROMPT_FILE, 'utf8').trimEnd(),
    EXPORT_DATA_NOTICE,
    '## DOM Outlines',
    `${outlines.length} unmarked kept pages.`,
    ...outlines.map(outlineSection),
    '## Discovery Notes',
    fenced(JSON.stringify(discovery.agentNotes, null, 2), 'json'),
  ].join('\n\n').concat('\n');
}

/** `proposal` without the `origin` key when it is a plain object; as it came otherwise. */
function withoutOrigin(proposal: Json): unknown {
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
    return proposal;
  }

  return Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== 'origin'));
}

/** Judges one proposal: the stamped entry, or its `invalid-shape` rejection. */
function judgeProposal(proposal: Json): ComponentEntry | RejectedCandidate {
  const parsed = candidateSchema.safeParse(withoutOrigin(proposal));

  return parsed.success
    ? { ...parsed.data, origin: 'agent' }
    : { candidate: proposal, reasons: [{ code: 'invalid-shape', detail: z.prettifyError(parsed.error) }] };
}

/** True when `result` is a rejection rather than an entry. */
function isRejection(result: ComponentEntry | RejectedCandidate): result is RejectedCandidate {
  return 'reasons' in result;
}

/**
 * Runs the seed agent once over the outlines of the unmarked kept pages
 * and returns its proposals, shape-checked. Writes nothing.
 *
 * @param outlines - One outline per unmarked kept page.
 * @param discovery - The discovery report; its `agentNotes` go in the
 * prompt.
 * @param spawn - Runs the agent once on the built prompt.
 * @returns The candidates stamped `origin: 'agent'` whatever the agent
 * wrote, and the `invalid-shape` rejections, both in answer order.
 * @throws Error the system error when {@link SEED_PROMPT_FILE} cannot be
 * read, before the agent runs.
 * @throws AgentOutputError when the output holds no single JSON object, or
 * that object is not `{ "components": [...] }` with no other key.
 */
export async function runSeedAgent(
  outlines: readonly DomOutline[],
  discovery: Pick<DiscoveryReport, 'agentNotes'>,
  spawn: AgentSpawner,
): Promise<SeedAgentResult> {
  const output = await spawn(buildSeedPrompt(outlines, discovery));
  const answer = agentAnswerSchema.safeParse(extractJsonObject(output));

  if (!answer.success) {
    throw new AgentOutputError(output, `expected one { "${COMPONENTS_KEY}": [...] } object: ${z.prettifyError(answer.error)}`);
  }

  const results = answer.data[COMPONENTS_KEY].map(judgeProposal);

  return {
    candidates: results.filter((result): result is ComponentEntry => !isRejection(result)),
    rejected: results.filter(isRejection),
  };
}
