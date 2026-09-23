import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import mammoth from 'mammoth';

// Very large pages are mostly boilerplate; this keeps requests well inside
// the model's context window while retaining the full text of an article.
const MAX_TEXT_CHARS = 400_000;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.htm', '.html', '.rtf']);

/**
 * Loads the source material for an entry so it can be analysed.
 * Returns { kind: 'pdf', data } (base64), { kind: 'text', text }, or
 * { kind: 'none', reason } when nothing could be read.
 */
export async function loadSource(entry, uploadsDir) {
  if (entry.attachment_path) {
    return loadAttachment(path.join(uploadsDir, entry.attachment_path), entry.attachment_name);
  }
  if (entry.link) {
    return fetchLink(entry.link);
  }
  return { kind: 'none', reason: 'No link or document was supplied.' };
}

async function loadAttachment(filePath, originalName = '') {
  const ext = path.extname(originalName || filePath).toLowerCase();
  try {
    if (ext === '.pdf') {
      const buf = await fs.readFile(filePath);
      return { kind: 'pdf', data: buf.toString('base64') };
    }
    if (ext === '.docx') {
      const { value } = await mammoth.extractRawText({ path: filePath });
      return textSource(value);
    }
    if (TEXT_EXTENSIONS.has(ext)) {
      const raw = await fs.readFile(filePath, 'utf8');
      return textSource(ext.startsWith('.htm') ? htmlToText(raw) : raw);
    }
    return {
      kind: 'none',
      reason: `Documents of type "${ext || 'unknown'}" cannot be read automatically. Upload a PDF, Word (.docx) or text file.`,
    };
  } catch (err) {
    return { kind: 'none', reason: `The attached document could not be read (${err.message}).` };
  }
}

export async function fetchLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'none', reason: 'The link is not a valid web address.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateHost(parsed.hostname)) {
    return { kind: 'none', reason: 'Only public http(s) links can be read.' };
  }

  try {
    const res = await fetch(parsed, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ED-LGR-DB/1.0)',
        Accept: 'text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    if (!res.ok) {
      return { kind: 'none', reason: `The website returned an error (HTTP ${res.status}).` };
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('application/pdf') || parsed.pathname.toLowerCase().endsWith('.pdf')) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_PDF_BYTES) {
        return { kind: 'none', reason: 'The linked PDF is too large to analyse (over 30 MB).' };
      }
      return { kind: 'pdf', data: buf.toString('base64') };
    }
    const body = await res.text();
    return textSource(type.includes('html') || /<html/i.test(body) ? htmlToText(body) : body);
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'the website took too long to respond' : err.message;
    return { kind: 'none', reason: `The link could not be opened (${reason}).` };
  }
}

function textSource(text) {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  if (!clean) return { kind: 'none', reason: 'No readable text was found.' };
  return { kind: 'text', text: clean.slice(0, MAX_TEXT_CHARS) };
}

export function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  // Prefer the main article body where the page marks one up.
  const main =
    (html.match(/<article[\s\S]*<\/article>/i) || html.match(/<main[\s\S]*<\/main>/i) || [html])[0];
  const body = main
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities((title ? `${title.trim()}\n\n` : '') + body);
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

// Stops the server being used to reach machines on its own private network.
function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(host)) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  }
  return false;
}
