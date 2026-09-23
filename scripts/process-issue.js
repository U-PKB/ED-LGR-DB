// Run by .github/workflows/entries.yml whenever an entry issue is opened,
// edited, labelled, closed or reopened. Writes data/entries/<issue>.json and
// posts the briefing back to the issue.
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyseEntry, describeError, isAnalysisConfigured } from '../src/analyse.js';
import { loadSource } from '../src/content.js';
import { ANALYSIS_STATUS } from '../src/constants.js';
import { entryFromIssue, isEntryIssue } from '../src/issue.js';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const MARKER = '<!-- ed-lgr-briefing -->';

export const LABELS = {
  entry: { color: '5b2c86', description: 'An entry in the ED & LGR database' },
  approved: { color: '1f883d', description: 'Approved for the database by a maintainer' },
  'awaiting approval': { color: 'e6007e', description: 'Waiting for a maintainer to approve' },
  'needs changes': { color: 'b3261e', description: 'The entry form needs correcting' },
  reanalyse: { color: 'fbca04', description: 'Add this label to write the briefing again' },
};

/** Minimal GitHub REST client using the workflow token. */
export function githubClient({ token, repo, apiUrl = 'https://api.github.com' }) {
  async function request(method, route, body) {
    const res = await fetch(`${apiUrl}/repos/${repo}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 404 && res.status !== 422) {
      throw new Error(`GitHub API ${method} ${route} failed: ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  return {
    async addLabels(number, names) {
      for (const name of names) {
        await request('POST', '/labels', { name, ...LABELS[name] }); // 422 if it already exists
      }
      await request('POST', `/issues/${number}/labels`, { labels: names });
    },
    removeLabel: (number, name) =>
      request('DELETE', `/issues/${number}/labels/${encodeURIComponent(name)}`),
    async upsertComment(number, body) {
      const comments = (await request('GET', `/issues/${number}/comments?per_page=100`)) || [];
      const mine = comments.find((c) => c.body?.includes(MARKER) && c.user?.type === 'Bot');
      const text = `${MARKER}\n${body}`;
      if (mine) await request('PATCH', `/issues/comments/${mine.id}`, { body: text });
      else await request('POST', `/issues/${number}/comments`, { body: text });
    },
  };
}

function hasLabel(issue, name) {
  return (issue.labels || []).some((l) => (typeof l === 'string' ? l : l.name) === name);
}

/**
 * Handles one issue event. Returns a short description of what was done.
 * `analyse` and `github` can be swapped out in tests.
 */
export async function processEvent(event, { dataDir, github, analyse = analyseEntry, analysisEnabled = isAnalysisConfigured() }) {
  const { action, issue } = event;
  if (!issue || issue.pull_request || !isEntryIssue(issue.body)) return 'skipped: not an entry';

  const file = path.join(dataDir, `${issue.number}.json`);

  if (action === 'closed') {
    await fs.rm(file, { force: true });
    return 'removed';
  }
  if (action === 'labeled' && !['approved', 'reanalyse'].includes(event.label?.name)) {
    return 'skipped: label not relevant';
  }
  if (action === 'edited' && !event.changes?.title && !event.changes?.body) {
    return 'skipped: nothing to re-analyse';
  }

  // Anyone on GitHub can open an issue on a public repository, so entries from
  // people outside the repository wait for a maintainer to add "approved".
  const trusted = TRUSTED.has(issue.author_association) || hasLabel(issue, 'approved');
  if (!trusted) {
    if (!hasLabel(issue, 'awaiting approval')) {
      await github.addLabels(issue.number, ['awaiting approval']);
      await github.upsertComment(
        issue.number,
        'Thank you for your entry. A maintainer will review it shortly. Once they add the **approved** label, the briefing will be written and the entry added to the database.',
      );
    }
    return 'awaiting approval';
  }

  const { entry, errors } = entryFromIssue(issue);
  if (errors.length) {
    await github.addLabels(issue.number, ['needs changes']);
    await github.upsertComment(
      issue.number,
      `This entry could not be added yet. Please edit the issue to correct the following:\n\n${errors.map((e) => `- ${e}`).join('\n')}`,
    );
    return 'needs changes';
  }

  let result = { analysis_status: ANALYSIS_STATUS.NOT_CONFIGURED, analysis_error: 'Automatic analysis is switched off because the ANTHROPIC_API_KEY secret is not set.' };
  if (analysisEnabled) {
    try {
      const source = await loadSource(entry);
      const analysis = await analyse(entry, source);
      result = {
        relevance: analysis.relevance,
        briefing: analysis.briefing,
        key_messages: analysis.key_messages,
        keywords: entry.keywords || analysis.suggested_keywords.join(', '),
        analysis_status: ANALYSIS_STATUS.COMPLETE,
        // Questions have no source to read, so only flag unreadable links and documents.
        analysis_error: source.kind === 'none' && (entry.link || entry.attachment_url) ? source.reason : null,
        analysed_at: new Date().toISOString(),
      };
    } catch (err) {
      console.error(err);
      result = { analysis_status: ANALYSIS_STATUS.FAILED, analysis_error: describeError(err) };
    }
  }

  const saved = {
    relevance: null,
    briefing: null,
    key_messages: [],
    analysed_at: null,
    ...entry,
    ...result,
    updated_at: new Date().toISOString(),
  };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(saved, null, 2) + '\n');

  await github.addLabels(issue.number, ['entry']);
  for (const name of ['awaiting approval', 'needs changes', 'reanalyse']) {
    if (hasLabel(issue, name)) await github.removeLabel(issue.number, name);
  }
  await github.upsertComment(issue.number, briefingComment(saved));
  return saved.analysis_status;
}

export function briefingComment(e) {
  if (e.analysis_status !== ANALYSIS_STATUS.COMPLETE) {
    return `Entry ${e.id} has been saved to the database, but the briefing could not be written.\n\n> ${e.analysis_error}\n\nTo try again, add the **reanalyse** label.`;
  }
  return [
    `## Briefing · Relevance: ${e.relevance}`,
    '',
    e.briefing,
    '',
    '### Key messages',
    '',
    ...e.key_messages.map((m, i) => `${i + 1}. ${m}`),
    '',
    e.analysis_error ? `> **The source could not be read**, so this briefing is based on the details entered only. ${e.analysis_error}\n` : '',
    `_Written automatically. Check important details against the source. To write it again, add the **reanalyse** label._`,
  ].join('\n');
}

// Command-line entry point used by the workflow.
if (import.meta.url === `file://${process.argv[1]}`) {
  const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const github = githubClient({
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL,
  });
  const outcome = await processEvent(event, { dataDir: path.resolve('data/entries'), github });
  console.log(`Issue ${event.issue?.number}: ${outcome}`);
}
