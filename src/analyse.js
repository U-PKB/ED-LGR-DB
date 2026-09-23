import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { CATEGORIES, RELEVANCE_LEVELS } from './constants.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
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
  client ??= new Anthropic();
  return client;
}

export function isAnalysisConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function describeEntry(entry, source) {
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

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key is invalid.';
  if (err instanceof Anthropic.RateLimitError) return 'Too many requests to the analysis service. Try again shortly.';
  if (err instanceof Anthropic.BadRequestError) {
    return `The analysis request was rejected: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return 'Could not connect to the analysis service.';
  if (err instanceof Anthropic.APIError) return `The analysis service returned an error (${err.status ?? 'unknown'}).`;
  return err?.message || String(err);
}
