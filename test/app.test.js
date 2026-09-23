import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AnalysisSchema } from '../src/analyse.js';
import { createApp } from '../src/app.js';
import { htmlToText } from '../src/content.js';

async function withServer(analyse, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-lgr-'));
  const { app, db, queue } = createApp({ dataDir, analyse });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, db, queue });
  } finally {
    server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function waitForIdle(queue) {
  for (let i = 0; i < 100 && !queue.idle; i++) await new Promise((r) => setTimeout(r, 10));
}

const fakeAnalysis = {
  relevance: 'High',
  briefing: 'A short briefing.\n\nWhat it means for members.',
  key_messages: ['First message.', 'Second message.'],
  suggested_keywords: ['TUPE', 'unitary'],
};

test('adding a question stores every field and the analysis', async () => {
  const seen = [];
  const analyse = async (entry, source) => {
    seen.push({ entry, source });
    return fakeAnalysis;
  };
  await withServer(analyse, async ({ base, queue }) => {
    const form = new FormData();
    form.append('title', 'What happens to staff pensions under the unitary proposal?');
    form.append('category', 'LGR');
    form.append('region', 'South East');
    form.append('authority', 'Surrey County Council');
    form.append('notes', 'Raised by branch secretary.');
    form.append('date_entered', '2026-09-01');

    const res = await fetch(`${base}/api/entries`, { method: 'POST', body: form });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(typeof created.id, 'number');

    await waitForIdle(queue);
    const entry = await (await fetch(`${base}/api/entries/${created.id}`)).json();
    assert.equal(entry.category, 'LGR');
    assert.equal(entry.region, 'South East');
    assert.equal(entry.authority, 'Surrey County Council');
    assert.equal(entry.date_entered, '2026-09-01');
    assert.equal(entry.analysis_status, 'complete');
    assert.equal(entry.relevance, 'High');
    assert.deepEqual(entry.key_messages, fakeAnalysis.key_messages);
    assert.equal(entry.keywords, 'TUPE, unitary', 'blank keywords are filled from the analysis');
    assert.equal(seen[0].source.kind, 'none');
  });
});

test('user keywords are kept and uploaded documents are read', async () => {
  let source;
  const analyse = async (_entry, s) => {
    source = s;
    return fakeAnalysis;
  };
  await withServer(analyse, async ({ base, queue }) => {
    const form = new FormData();
    form.append('category', 'ED');
    form.append('region', 'National');
    form.append('keywords', 'mayor; strategic authority');
    form.append('attachment', new Blob(['Devolution white paper summary.'], { type: 'text/plain' }), 'summary.txt');

    const created = await (await fetch(`${base}/api/entries`, { method: 'POST', body: form })).json();
    await waitForIdle(queue);
    const entry = await (await fetch(`${base}/api/entries/${created.id}`)).json();
    assert.equal(entry.keywords, 'mayor, strategic authority');
    assert.equal(entry.attachment_name, 'summary.txt');
    assert.deepEqual(source, { kind: 'text', text: 'Devolution white paper summary.' });

    const download = await fetch(`${base}/api/entries/${created.id}/attachment`);
    assert.equal(await download.text(), 'Devolution white paper summary.');
  });
});

test('invalid entries are rejected with British English messages', async () => {
  await withServer(async () => fakeAnalysis, async ({ base }) => {
    const form = new FormData();
    form.append('category', 'XYZ');
    form.append('region', 'Nowhere');
    form.append('link', 'not a link');
    const res = await fetch(`${base}/api/entries`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
    const { error } = await res.json();
    assert.match(error, /category of LGR or ED/);
    assert.match(error, /UNISON region or National/);
    assert.match(error, /full web address/);
  });
});

test('failed analyses are recorded and the entry can be deleted', async () => {
  await withServer(async () => { throw new Error('boom'); }, async ({ base, queue }) => {
    const form = new FormData();
    form.append('title', 'Question');
    form.append('category', 'ED');
    form.append('region', 'Northern');
    const created = await (await fetch(`${base}/api/entries`, { method: 'POST', body: form })).json();
    await waitForIdle(queue);
    const entry = await (await fetch(`${base}/api/entries/${created.id}`)).json();
    assert.equal(entry.analysis_status, 'failed');
    assert.equal(entry.analysis_error, 'boom');

    assert.equal((await fetch(`${base}/api/entries/${created.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/api/entries/${created.id}`)).status, 404);
  });
});

test('CSV export includes briefings', async () => {
  await withServer(async () => fakeAnalysis, async ({ base, queue }) => {
    const form = new FormData();
    form.append('title', 'Question');
    form.append('category', 'LGR');
    form.append('region', 'Scotland');
    await fetch(`${base}/api/entries`, { method: 'POST', body: form });
    await waitForIdle(queue);
    const csv = await (await fetch(`${base}/api/export.csv`)).text();
    assert.match(csv, /"Council or strategic authority"/);
    assert.match(csv, /A short briefing/);
  });
});

test('HTML is reduced to readable text', () => {
  const text = htmlToText(
    '<html><head><title>News &amp; views</title><style>p{}</style></head><body><nav>Menu</nav><article><h1>Reorganisation</h1><p>Staff&nbsp;will transfer under TUPE.</p></article></body></html>',
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
