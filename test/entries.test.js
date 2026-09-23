import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AnalysisSchema } from '../src/analyse.js';
import { htmlToText, readBuffer } from '../src/content.js';
import { entryFromIssue, isEntryIssue, parseAttachment, parseUkDate } from '../src/issue.js';
import { buildSite } from '../scripts/build-site.js';
import { processEvent } from '../scripts/process-issue.js';

// What GitHub produces from .github/ISSUE_TEMPLATE/new-entry.yml.
function formBody(fields = {}) {
  const f = {
    link: '_No response_',
    document: '_No response_',
    category: 'LGR – Local Government Reorganisation',
    region: 'South East',
    authority: 'Surrey County Council',
    date: '_No response_',
    keywords: '_No response_',
    notes: '_No response_',
    ...fields,
  };
  return [
    `### Article link\n\n${f.link}`,
    `### Document attachment\n\n${f.document}`,
    `### Category\n\n${f.category}`,
    `### UNISON region or National\n\n${f.region}`,
    `### Council or strategic authority\n\n${f.authority}`,
    `### Date entered\n\n${f.date}`,
    `### Keywords\n\n${f.keywords}`,
    `### Notes\n\n${f.notes}`,
  ].join('\n\n');
}

function makeIssue(overrides = {}) {
  return {
    number: 7,
    title: 'Surrey unitary proposal submitted',
    body: formBody(),
    created_at: '2026-09-23T22:30:00Z',
    html_url: 'https://github.com/U-PKB/ED-LGR-DB/issues/7',
    user: { login: 'someone' },
    author_association: 'OWNER',
    labels: [],
    ...overrides,
  };
}

function fakeGithub() {
  const calls = [];
  return {
    calls,
    addLabels: async (n, names) => calls.push(['addLabels', n, names]),
    removeLabel: async (n, name) => calls.push(['removeLabel', n, name]),
    upsertComment: async (n, body) => calls.push(['comment', n, body]),
  };
}

const fakeAnalysis = {
  relevance: 'High',
  briefing: 'A short briefing.\n\nWhat it means for members.',
  key_messages: ['First message.', 'Second message.'],
  suggested_keywords: ['TUPE', 'unitary'],
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ed-lgr-'));

test('issue form bodies are turned into entries', () => {
  const issue = makeIssue({
    body: formBody({
      document: 'Here it is: [Cabinet report.pdf](https://github.com/user-attachments/files/123/Cabinet.report.pdf)',
      date: '01/09/2026',
      keywords: 'TUPE; pay harmonisation',
      notes: 'Raised by the branch.',
    }),
  });
  assert.equal(isEntryIssue(issue.body), true);
  const { entry, errors } = entryFromIssue(issue);
  assert.deepEqual(errors, []);
  assert.equal(entry.id, 7);
  assert.equal(entry.category, 'LGR');
  assert.equal(entry.region, 'South East');
  assert.equal(entry.authority, 'Surrey County Council');
  assert.equal(entry.date_entered, '2026-09-01');
  assert.equal(entry.keywords, 'TUPE, pay harmonisation');
  assert.equal(entry.attachment_name, 'Cabinet report.pdf');
  assert.equal(entry.attachment_url, 'https://github.com/user-attachments/files/123/Cabinet.report.pdf');
  assert.equal(entry.link, null);
});

test('a blank date uses the UK date the issue was opened', () => {
  // 22:30 UTC on 23 September is 23:30 on the same day in London (BST).
  assert.equal(entryFromIssue(makeIssue()).entry.date_entered, '2026-09-23');
  assert.equal(entryFromIssue(makeIssue({ created_at: '2026-09-23T23:30:00Z' })).entry.date_entered, '2026-09-24');
});

test('invalid form values are reported in British English', () => {
  const { errors } = entryFromIssue(
    makeIssue({ title: '', body: formBody({ region: 'Nowhere', date: '31/02/2026', link: 'not a link' }) }),
  );
  assert.equal(errors.length, 4);
  assert.match(errors.join(' '), /UNISON region or National/);
  assert.match(errors.join(' '), /DD\/MM\/YYYY/);
  assert.match(errors.join(' '), /full web address/);
  assert.match(errors.join(' '), /Add a link, attach a document, or type a question/);
});

test('helpers parse dates and attachments', () => {
  assert.equal(parseUkDate('5/3/2026'), '2026-03-05');
  assert.equal(parseUkDate('2026-03-05'), '2026-03-05');
  assert.equal(parseUkDate('03/05'), null);
  assert.deepEqual(parseAttachment('https://example.org/files/report%20one.docx'), {
    name: 'report one.docx',
    url: 'https://example.org/files/report%20one.docx',
  });
  assert.equal(parseAttachment(''), null);
});

test('a new entry from the owner is analysed, saved and commented on', async () => {
  const dataDir = tmp();
  const github = fakeGithub();
  let analysedEntry;
  const outcome = await processEvent(
    { action: 'opened', issue: makeIssue({ title: 'What does this mean for pensions?' }) },
    {
      dataDir,
      github,
      analysisEnabled: true,
      analyse: async (entry, source) => {
        analysedEntry = { entry, source };
        return fakeAnalysis;
      },
    },
  );
  assert.equal(outcome, 'complete');
  assert.equal(analysedEntry.source.kind, 'none');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, '7.json'), 'utf8'));
  assert.equal(saved.relevance, 'High');
  assert.equal(saved.keywords, 'TUPE, unitary', 'blank keywords are filled from the analysis');
  assert.equal(saved.analysis_error, null, 'questions are not flagged as unreadable');
  assert.deepEqual(github.calls[0], ['addLabels', 7, ['entry']]);
  assert.match(github.calls.at(-1)[2], /Relevance: High[\s\S]*1\. First message\./);
});

test('entries from people outside the repository wait for approval', async () => {
  const dataDir = tmp();
  const github = fakeGithub();
  let analysed = false;
  const opts = { dataDir, github, analysisEnabled: true, analyse: async () => { analysed = true; return fakeAnalysis; } };

  const issue = makeIssue({ author_association: 'NONE' });
  assert.equal(await processEvent({ action: 'opened', issue }, opts), 'awaiting approval');
  assert.equal(analysed, false);
  assert.equal(fs.existsSync(path.join(dataDir, '7.json')), false);

  const approved = { ...issue, labels: [{ name: 'awaiting approval' }, { name: 'approved' }] };
  assert.equal(await processEvent({ action: 'labeled', label: { name: 'approved' }, issue: approved }, opts), 'complete');
  assert.equal(analysed, true);
  assert.ok(github.calls.some(([op, , name]) => op === 'removeLabel' && name === 'awaiting approval'));
});

test('closing an issue removes the entry and other events are ignored', async () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, '7.json'), '{}');
  const opts = { dataDir, github: fakeGithub(), analysisEnabled: false };
  assert.equal(await processEvent({ action: 'labeled', label: { name: 'bug' }, issue: makeIssue() }, opts), 'skipped: label not relevant');
  assert.equal(await processEvent({ action: 'opened', issue: makeIssue({ body: 'Just a bug report' }) }, opts), 'skipped: not an entry');
  assert.equal(await processEvent({ action: 'closed', issue: makeIssue() }, opts), 'removed');
  assert.equal(fs.existsSync(path.join(dataDir, '7.json')), false);
});

test('without an API key the entry is still saved', async () => {
  const dataDir = tmp();
  const outcome = await processEvent({ action: 'opened', issue: makeIssue() }, { dataDir, github: fakeGithub(), analysisEnabled: false });
  assert.equal(outcome, 'not_configured');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, '7.json'), 'utf8'));
  assert.match(saved.analysis_error, /ANTHROPIC_API_KEY/);
});

test('the site build combines entries newest first', async () => {
  const dataDir = tmp();
  const outDir = path.join(tmp(), 'site');
  fs.writeFileSync(path.join(dataDir, '1.json'), JSON.stringify({ id: 1, date_entered: '2026-01-01' }));
  fs.writeFileSync(path.join(dataDir, '2.json'), JSON.stringify({ id: 2, date_entered: '2026-02-01' }));
  const { count } = await buildSite({ dataDir, outDir, repo: 'U-PKB/ED-LGR-DB' });
  assert.equal(count, 2);
  const entries = JSON.parse(fs.readFileSync(path.join(outDir, 'entries.json'), 'utf8'));
  assert.deepEqual(entries.map((e) => e.id), [2, 1]);
  const config = JSON.parse(fs.readFileSync(path.join(outDir, 'config.json'), 'utf8'));
  assert.equal(config.newEntryUrl, 'https://github.com/U-PKB/ED-LGR-DB/issues/new?template=new-entry.yml');
  assert.ok(fs.existsSync(path.join(outDir, 'index.html')));
});

test('documents and web pages are read as text or PDF', async () => {
  assert.equal((await readBuffer(Buffer.from('%PDF-1.4'), { ext: '.pdf' })).kind, 'pdf');
  assert.deepEqual(await readBuffer(Buffer.from('Plain text'), { ext: '.txt' }), { kind: 'text', text: 'Plain text' });
  assert.equal((await readBuffer(Buffer.from('x'), { ext: '.zip' })).kind, 'none');
  const text = htmlToText(
    '<html><head><title>News &amp; views</title></head><body><nav>Menu</nav><article><p>Staff&nbsp;will transfer under TUPE.</p></article></body></html>',
  );
  assert.match(text, /News & views/);
  assert.match(text, /Staff will transfer under TUPE\./);
  assert.doesNotMatch(text, /Menu/);
});

test('the analysis schema converts to a structured output format', () => {
  const format = betaZodOutputFormat(AnalysisSchema);
  assert.equal(format.type, 'json_schema');
  assert.deepEqual(format.schema.required.sort(), ['briefing', 'key_messages', 'relevance', 'suggested_keywords']);
});
