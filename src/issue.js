import { CATEGORIES, REGIONS } from './constants.js';

// Headings used by .github/ISSUE_TEMPLATE/new-entry.yml, mapped to entry fields.
const HEADINGS = {
  'Article link': 'link',
  'Document attachment': 'document',
  Category: 'category',
  'UNISON region or National': 'region',
  'Council or strategic authority': 'authority',
  'Date entered': 'date_entered',
  Keywords: 'keywords',
  Notes: 'notes',
};

/** True when an issue was created from the "Add an entry" form. */
export function isEntryIssue(body) {
  return typeof body === 'string' && /^### Category\s*$/m.test(body) && /^### UNISON region or National\s*$/m.test(body);
}

/** Splits an issue form body into { fieldName: value }. */
export function parseSections(body) {
  const fields = {};
  const parts = body.replace(/\r\n/g, '\n').split(/^### /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    const key = HEADINGS[heading];
    if (!key) continue;
    const value = newline === -1 ? '' : part.slice(newline + 1).trim();
    fields[key] = value === '_No response_' ? '' : value;
  }
  return fields;
}

/** Finds the first attached file ([name](url)) or bare link in a form field. */
export function parseAttachment(text) {
  if (!text) return null;
  const md = text.match(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
  if (md) return { name: md[1].trim(), url: md[2] };
  const bare = text.match(/https?:\/\/\S+/);
  if (bare) {
    const url = bare[0].replace(/[>)\].,]+$/, '');
    return { name: decodeURIComponent(url.split('/').pop() || 'document'), url };
  }
  return null;
}

/** Converts DD/MM/YYYY (or YYYY-MM-DD) to YYYY-MM-DD, or returns null. */
export function parseUkDate(text) {
  const value = text.trim();
  let y, m, d;
  let match = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (match) [, d, m, y] = match.map(Number);
  else if ((match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [, y, m, d] = match.map(Number);
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** The date (YYYY-MM-DD) in the UK for a timestamp. */
export function ukDate(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(iso));
}

/**
 * Turns a GitHub issue created from the form into an entry.
 * Returns { entry, errors }.
 */
export function entryFromIssue(issue) {
  const f = parseSections(issue.body || '');
  const errors = [];

  const category = (f.category || '').split(/\s/)[0].toUpperCase();
  if (!(category in CATEGORIES)) errors.push('Choose a category of LGR or ED.');

  const region = (f.region || '').trim();
  if (!REGIONS.includes(region)) errors.push('Choose a UNISON region or National.');

  let link = (f.link || '').trim() || null;
  if (link) {
    try {
      const url = new URL(link);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      errors.push('The article link must be a full web address starting with http:// or https://.');
      link = null;
    }
  }

  const attachment = parseAttachment(f.document);

  let dateEntered = ukDate(issue.created_at);
  if (f.date_entered) {
    const parsed = parseUkDate(f.date_entered);
    if (parsed) dateEntered = parsed;
    else errors.push('The date entered must be written as DD/MM/YYYY.');
  }

  const title = (issue.title || '').trim();
  const notes = (f.notes || '').trim();
  if (!link && !attachment && !title && !notes) {
    errors.push('Add a link, attach a document, or type a question.');
  }

  const entry = {
    id: issue.number,
    title,
    link,
    attachment_name: attachment?.name ?? null,
    attachment_url: attachment?.url ?? null,
    category,
    notes,
    keywords: (f.keywords || '')
      .split(/[,;\n]/)
      .map((k) => k.trim())
      .filter(Boolean)
      .join(', '),
    date_entered: dateEntered,
    region,
    authority: (f.authority || '').trim(),
    issue_url: issue.html_url,
    added_by: issue.user?.login ?? null,
  };
  return { entry, errors };
}
