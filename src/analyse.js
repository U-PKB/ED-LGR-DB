import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { CATEGORIES, RELEVANCE_LEVELS } from './constants.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const EFFORT = process.env.ANALYSIS_EFFORT || 'high';

export const AnalysisSchema = z.object({
  relevance: z.enum(RELEVANCE_LEVELS),
  briefing: z.string(),
  key_messages: z.array(z.string()),
  suggested_keywords: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are a policy officer in UNISON's local government service group, the UK's largest public service trade union. You write short briefings for UNISON officers, branch secretaries and regional organisers about Local Government Reorganisation (LGR) and English Devolution (ED), including combined authorities, combined county authorities and strategic authorities.

For each item you are given, assess how relevant it is to UNISON and to the workforce of local councils, combined authorities and strategic authorities. Consider, where they apply: jobs and job security; restructuring, redundancies and redeployment; TUPE and transfers of staff between employers; pay, pay harmonisation, terms and conditions and the NJC/Green Book; pensions (LGPS); equality impacts on the workforce; outsourcing, insourcing and shared services; service delivery and funding pressures that affect staff; timetables, consultation and statutory processes; collective bargaining, facility time and union recognition in new or merged bodies; and the political and governance context (mayors, shadow authorities, Government decisions).

Write in British English with British spelling (for example "organisation", "analyse", "programme", "labour") and plain, professional language. Do not invent facts: base your analysis only on the material supplied, and say plainly when the source could not be read or gives too little to go on.

Return:
- relevance: "High" if the item directly affects the jobs, pay, terms or representation of council/authority staff; "Medium" if it has clear but indirect implications for the workforce or UNISON's organising and bargaining; "Low" if the connection is slight; "Not relevant" if there is none.
- briefing: a short briefing of 120 to 200 words in two or three paragraphs, separated by a blank line. Summarise what the item says, then explain what it means for UNISON members and the workforce, naming the councils or authorities involved.
- key_messages: three to five short, punchy key messages for UNISON officers, each a single sentence, written so that they could be used with branches, members or employers.
- suggested_keywords: three to eight short keywords or phrases useful for searching the database (for example "TUPE", "unitary proposal", "mayoral combined authority").`;

let client;
function getClient() {
  // Tolerate spaces, line breaks or quote marks pasted in with the key.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim().replace(/^["']|["']$/g, '') || undefined;
  client ??= new Anthropic({ apiKey });
  return client;
}

/** A Claude subscription token (from `claude setup-token`) takes priority over an API key. */
export function usesSubscription() {
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
}

export function isAnalysisConfigured() {
  return usesSubscription() || Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** `sourceFile` is set when the source is saved to a file for Claude Code to read. */
function describeEntry(entry, source, sourceFile) {
  const lines = [
    `Category: ${entry.category} (${CATEGORIES[entry.category]})`,
    `UNISON region: ${entry.region}`,
    entry.authority && `Council or strategic authority: ${entry.authority}`,
    entry.title && `Title or question: ${entry.title}`,
    entry.link && `Link: ${entry.link}`,
    entry.attachment_name && `Attached document: ${entry.attachment_name}`,
    entry.keywords && `Keywords given by the person who added it: ${entry.keywords}`,
    entry.notes && `Notes from the person who added it:\n${entry.notes}`,
  ].filter(Boolean);

  if (source.kind === 'none') {
    lines.push(
      `\nThe source material could not be read: ${source.reason} Base your analysis on the details above only, and say in the briefing that the source was not read.`,
    );
  } else if (sourceFile) {
    lines.push(`\nThe source is in the file ${sourceFile} in the current folder. Read all of it before writing your analysis.`);
  } else if (source.kind === 'text') {
    lines.push(`\nText of the source:\n<source>\n${source.text}\n</source>`);
  } else {
    lines.push('\nThe source document is attached above.');
  }
  lines.push(
    '\nAnalyse this item for its relevance to UNISON and the local government workforce. If it is a question rather than an article, answer it briefly in the briefing from the UNISON and workforce perspective.',
  );
  return lines.join('\n');
}

/** Sends one entry to Claude and returns the parsed analysis. */
export async function analyseEntry(entry, source) {
  return usesSubscription() ? analyseWithSubscription(entry, source) : analyseWithApiKey(entry, source);
}

async function analyseWithApiKey(entry, source) {
  const content = [];
  if (source.kind === 'pdf') {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: source.data },
    });
  }
  content.push({ type: 'text', text: describeEntry(entry, source) });

  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    output_config: { effort: EFFORT, format: betaZodOutputFormat(AnalysisSchema) },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to analyse this item.');
  }
  if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
    throw new Error('The analysis was incomplete. Try re-analysing the entry.');
  }
  return response.parsed_output;
}

/**
 * Runs the analysis through the Claude Code command line, which signs in with
 * a Claude Pro or Max subscription token instead of an API key.
 */
async function analyseWithSubscription(entry, source) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ed-lgr-'));
  try {
    let sourceFile = null;
    if (source.kind === 'pdf') {
      sourceFile = 'source.pdf';
      await fs.writeFile(path.join(dir, sourceFile), Buffer.from(source.data, 'base64'));
    } else if (source.kind === 'text') {
      sourceFile = 'source.txt';
      await fs.writeFile(path.join(dir, sourceFile), source.text);
    }

    const args = [
      '-p', describeEntry(entry, source, sourceFile),
      '--output-format', 'json',
      '--json-schema', JSON.stringify(z.toJSONSchema(AnalysisSchema)),
      '--system-prompt', SYSTEM_PROMPT,
      // Claude may only read the files in this folder.
      '--tools', 'Read',
      '--allowedTools', 'Read',
    ];
    if (process.env.ANTHROPIC_MODEL) args.push('--model', process.env.ANTHROPIC_MODEL);

    const stdout = await runCli(args, dir);
    let output;
    try {
      output = JSON.parse(stdout);
    } catch {
      throw new Error('Claude Code returned an unexpected response.');
    }
    if (output.is_error) throw new SubscriptionError(output.result || output.subtype || 'Claude Code reported an error.');

    let analysis = output.structured_output;
    if (!analysis && typeof output.result === 'string') {
      const json = output.result.match(/\{[\s\S]*\}/);
      analysis = json ? JSON.parse(json[0]) : null;
    }
    const parsed = AnalysisSchema.safeParse(analysis);
    if (!parsed.success) throw new Error('The analysis was incomplete. Try re-analysing the entry.');
    return parsed.data;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

class SubscriptionError extends Error {}

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.CLAUDE_CLI || 'claude',
      args,
      { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, ANTHROPIC_API_KEY: '' } },
      (err, stdout, stderr) => {
        // A failed run can still print a JSON result that explains the error.
        if (stdout.trim().startsWith('{')) return resolve(stdout);
        if (err?.code === 'ENOENT') return reject(new Error('Claude Code is not installed on the runner.'));
        reject(new SubscriptionError((stderr || err?.message || 'Claude Code failed.').trim().slice(0, 500)));
      },
    );
  });
}

export function describeError(err) {
  if (err instanceof SubscriptionError) {
    if (/auth|login|token|401|403|oauth/i.test(err.message)) {
      return 'Claude rejected the subscription token. Run "claude setup-token" again and update the CLAUDE_CODE_OAUTH_TOKEN secret.';
    }
    if (/limit|usage|quota|429/i.test(err.message)) {
      return 'Your Claude subscription usage limit has been reached. Add the reanalyse label to try again later.';
    }
    return `Claude Code reported an error: ${err.message}`;
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic rejected the API key. Check that the ANTHROPIC_API_KEY secret is an API key from console.anthropic.com (it starts "sk-ant-api") and has not been deleted.';
  }
  if (err instanceof Anthropic.RateLimitError) return 'Too many requests to the analysis service. Try again shortly.';
  if (err instanceof Anthropic.BadRequestError) {
    return `The analysis request was rejected: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return 'Could not connect to the analysis service.';
  if (err instanceof Anthropic.APIError) return `The analysis service returned an error (${err.status ?? 'unknown'}).`;
  return err?.message || String(err);
}
