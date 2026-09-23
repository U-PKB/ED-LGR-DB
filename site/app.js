const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  entries: [],
  options: null,
  selectedId: null,
};

const els = {
  body: $('#entries-body'),
  table: $('.table-wrap'),
  empty: $('#empty-state'),
  count: $('#result-count'),
  search: $('#filter-search'),
  category: $('#filter-category'),
  region: $('#filter-region'),
  relevance: $('#filter-relevance'),
  detail: $('#detail'),
  detailKicker: $('#detail-kicker'),
  detailTitle: $('#detail-title'),
  detailBody: $('#detail-body'),
  toast: $('#toast'),
};

// ---------- Helpers ----------

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const formatDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z]+/g, '-');

const entryTitle = (e) =>
  e.title || e.attachment_name || (e.link && hostOf(e.link)) || (e.notes && e.notes.slice(0, 80)) || `Entry ${e.id}`;


function relevanceBadge(e) {
  if (e.analysis_status === 'failed') return '<span class="badge badge-failed">Analysis failed</span>';
  if (e.analysis_status === 'not_configured') return '<span class="badge badge-off">Not analysed</span>';
  if (!e.relevance) return '';
  return `<span class="badge badge-${slug(e.relevance)}">${escapeHtml(e.relevance)}</span>`;
}

const categoryBadge = (c) => `<span class="badge badge-${c.toLowerCase()}" title="${escapeHtml(state.options?.categories[c] ?? '')}">${escapeHtml(c)}</span>`;

const icons = {
  link: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"/></svg>',
  doc: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 2H5.5A1.5 1.5 0 0 0 4 3.5v13A1.5 1.5 0 0 0 5.5 18h9a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M11 2v5h5"/></svg>',
  question: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M7.8 7.5a2.3 2.3 0 0 1 4.4.8c0 1.5-2.2 2-2.2 3.2M10 14.5h.01"/></svg>',
};

function sourceSummary(e) {
  if (e.attachment_name) return `${icons.doc}<span>${escapeHtml(e.attachment_name)}</span>`;
  if (e.link) return `${icons.link}<span>${escapeHtml(hostOf(e.link))}</span>`;
  return `${icons.question}<span>Question</span>`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { els.toast.hidden = true; }, 3200);
}

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status}).`);
  return res.json();
}

// ---------- Loading and rendering ----------

async function loadData() {
  const [config, entries] = await Promise.all([getJson('config.json'), getJson('entries.json')]);
  state.options = config;
  state.entries = entries;
  const { categories, regions, relevanceLevels, newEntryUrl, repo } = config;

  const opts = (pairs) => pairs.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
  const categoryPairs = Object.entries(categories).map(([k, v]) => [k, `${k} – ${v}`]);

  els.category.insertAdjacentHTML('beforeend', opts(categoryPairs));
  els.region.insertAdjacentHTML('beforeend', opts(regions.map((r) => [r, r])));
  els.relevance.insertAdjacentHTML('beforeend', opts(relevanceLevels.map((r) => [r, r])) + '<option value="__unanalysed">Not yet analysed</option>');

  for (const link of [$('#add-entry'), $('#add-first')]) link.href = newEntryUrl || '#';
  $('#how-to').href = repo ? `https://github.com/${repo}#readme` : '#';
  $('#updated-at').textContent = `· Last updated ${formatDateTime(config.builtAt)}`;

  render();
}

function filteredEntries() {
  const q = els.search.value.trim().toLowerCase();
  const cat = els.category.value;
  const region = els.region.value;
  const rel = els.relevance.value;
  return state.entries.filter((e) => {
    if (cat && e.category !== cat) return false;
    if (region && e.region !== region) return false;
    if (rel === '__unanalysed' && e.analysis_status === 'complete') return false;
    if (rel && rel !== '__unanalysed' && e.relevance !== rel) return false;
    if (!q) return true;
    const haystack = [
      e.id, e.title, e.link, e.attachment_name, e.notes, e.keywords, e.region, e.authority,
      e.briefing, ...(e.key_messages || []),
    ].join(' ').toLowerCase();
    return q.split(/\s+/).every((word) => haystack.includes(word));
  });
}

function render() {
  const all = state.entries;
  $('#stat-total').textContent = all.length;
  $('#stat-lgr').textContent = all.filter((e) => e.category === 'LGR').length;
  $('#stat-ed').textContent = all.filter((e) => e.category === 'ED').length;
  $('#stat-high').textContent = all.filter((e) => e.relevance === 'High').length;

  const rows = filteredEntries();
  els.empty.hidden = all.length > 0;
  els.table.hidden = all.length === 0;
  els.count.parentElement.hidden = all.length === 0;
  els.count.textContent = rows.length === all.length
    ? `Showing all ${all.length} ${all.length === 1 ? 'entry' : 'entries'}`
    : `Showing ${rows.length} of ${all.length} entries`;

  if (all.length && rows.length === 0) {
    els.body.innerHTML = '<tr class="no-match"><td colspan="7">No entries match your search. Try clearing a filter.</td></tr>';
  } else {
    els.body.innerHTML = rows.map((e) => {
      const keywords = e.keywords ? e.keywords.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 4) : [];
      return `
        <tr tabindex="0" data-id="${e.id}" aria-label="Open entry ${e.id}">
          <td class="col-id" data-label="ID">${e.id}</td>
          <td class="col-date" data-label="Date entered">${escapeHtml(formatDate(e.date_entered))}</td>
          <td class="col-entry">
            <span class="entry-title">${escapeHtml(entryTitle(e))}</span>
            <span class="entry-sub">${sourceSummary(e)}</span>
            ${keywords.length ? `<span class="entry-keywords">${keywords.map((k) => `<span class="chip">${escapeHtml(k)}</span>`).join('')}</span>` : ''}
          </td>
          <td data-label="Category">${categoryBadge(e.category)}</td>
          <td data-label="Region">${escapeHtml(e.region)}</td>
          <td data-label="Council / authority">${escapeHtml(e.authority) || '<span class="optional">—</span>'}</td>
          <td data-label="Relevance">${relevanceBadge(e)}</td>
        </tr>`;
    }).join('');
  }

  if (state.selectedId) renderDetail();
}

function renderAnalysis(e) {
  if (e.analysis_status === 'failed' || e.analysis_status === 'not_configured') {
    return `<div class="analysis"><div class="analysis-head"><h3>Briefing</h3></div>
      <p class="analysis-error">${escapeHtml(e.analysis_error || 'The analysis did not complete.')}</p>
      <p class="analysis-note">To try again, add the <strong>reanalyse</strong> label to the entry on GitHub.</p></div>`;
  }
  if (!e.briefing) return '';

  const paragraphs = e.briefing.split(/\n\s*\n/).map((p) => `<p>${escapeHtml(p.trim())}</p>`).join('');
  const messages = (e.key_messages || []).map((m) => `<li>${escapeHtml(m)}</li>`).join('');
  return `
    <section class="analysis" aria-labelledby="briefing-heading">
      <div class="analysis-head">
        <h3 id="briefing-heading">Briefing</h3>
        ${relevanceBadge(e)}
        <button class="btn btn-secondary copy-btn" type="button" data-action="copy-briefing">Copy</button>
      </div>
      <div class="briefing">${paragraphs}</div>
      ${messages ? `<h4>Key messages</h4><ol class="key-messages">${messages}</ol>` : ''}
      ${e.analysis_error ? `<p class="analysis-note"><strong>The source could not be read</strong>, so this briefing is based on the details entered only. ${escapeHtml(e.analysis_error)}</p>` : ''}
      <p class="analysis-note">Analysed automatically on ${escapeHtml(formatDateTime(e.analysed_at))}. Check important details against the source.</p>
    </section>`;
}

function renderDetail() {
  const e = state.entries.find((x) => x.id === state.selectedId);
  if (!e) { closeDetail(); return; }

  els.detailKicker.innerHTML = `<span>ID ${e.id}</span> ${categoryBadge(e.category)} <span>${escapeHtml(state.options.categories[e.category])}</span>`;
  els.detailTitle.textContent = entryTitle(e);

  const row = (label, value) => (value ? `<dt>${label}</dt><dd>${value}</dd>` : '');
  const source = e.link
    ? `<a href="${escapeHtml(e.link)}" target="_blank" rel="noopener noreferrer">${icons.link}${escapeHtml(e.link)}</a>`
    : '';
  const attachment = e.attachment_name
    ? `<a href="${escapeHtml(e.attachment_url)}" target="_blank" rel="noopener noreferrer">${icons.doc}${escapeHtml(e.attachment_name)}</a>`
    : '';

  els.detailBody.innerHTML = `
    ${renderAnalysis(e)}
    <dl class="details">
      ${row('Unique ID', String(e.id))}
      ${row('Link', source)}
      ${row('Document', attachment)}
      ${row('Category', `${escapeHtml(e.category)} – ${escapeHtml(state.options.categories[e.category])}`)}
      ${row('Date entered', escapeHtml(formatDate(e.date_entered)))}
      ${row('UNISON region', escapeHtml(e.region))}
      ${row('Council or strategic authority', escapeHtml(e.authority))}
      ${row('Keywords', e.keywords ? e.keywords.split(',').map((k) => `<span class="chip">${escapeHtml(k.trim())}</span>`).join(' ') : '')}
      ${row('Notes', escapeHtml(e.notes))}
      ${row('Added by', e.added_by ? escapeHtml(e.added_by) : '')}
    </dl>`;

  $('#detail-github').href = e.issue_url || '#';
}

// ---------- Detail drawer ----------

let lastFocus = null;

function openDetail(id) {
  lastFocus = document.activeElement;
  state.selectedId = id;
  renderDetail();
  if (!state.selectedId) return;
  history.replaceState(null, '', `#entry-${id}`);
  els.detail.classList.add('open');
  els.detail.setAttribute('aria-hidden', 'false');
  $('.icon-btn', els.detail).focus();
}

function closeDetail() {
  state.selectedId = null;
  els.detail.classList.remove('open');
  els.detail.setAttribute('aria-hidden', 'true');
  history.replaceState(null, '', location.pathname + location.search);
  lastFocus?.focus?.();
}

// ---------- CSV export ----------

function exportCsv() {
  const columns = [
    ['ID', (e) => e.id],
    ['Date entered', (e) => e.date_entered],
    ['Category', (e) => e.category],
    ['Title or question', (e) => e.title],
    ['Link', (e) => e.link],
    ['Document', (e) => e.attachment_url],
    ['UNISON region', (e) => e.region],
    ['Council or strategic authority', (e) => e.authority],
    ['Keywords', (e) => e.keywords],
    ['Notes', (e) => e.notes],
    ['Relevance', (e) => e.relevance],
    ['Briefing', (e) => e.briefing],
    ['Key messages', (e) => (e.key_messages || []).map((m) => `• ${m}`).join('\n')],
    ['GitHub', (e) => e.issue_url],
  ];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [columns.map(([h]) => cell(h)).join(',')].concat(
    filteredEntries().map((e) => columns.map(([, get]) => cell(get(e))).join(',')),
  );
  const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ed-lgr-database-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Events ----------

function bindEvents() {
  $('#export-csv').addEventListener('click', exportCsv);
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'close-detail') closeDetail();
    if (action === 'copy-briefing') copyBriefing();
  });

  els.body.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) openDetail(Number(row.dataset.id));
  });
  els.body.addEventListener('keydown', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openDetail(Number(row.dataset.id));
    }
  });

  [els.search, els.category, els.region, els.relevance].forEach((el) =>
    el.addEventListener('input', () => render()));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.selectedId) closeDetail();
  });
}

async function copyBriefing() {
  const e = state.entries.find((x) => x.id === state.selectedId);
  if (!e) return;
  const text = [
    entryTitle(e),
    ...(e.link || e.attachment_name ? [e.link || e.attachment_name] : []),
    `Relevance: ${e.relevance}`,
    '',
    e.briefing,
    '',
    'Key messages:',
    ...(e.key_messages || []).map((m) => `• ${m}`),
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Briefing copied to the clipboard.');
  } catch {
    toast('Could not copy. Select the text and copy it instead.');
  }
}

// ---------- Start ----------

(async function init() {
  bindEvents();
  try {
    await loadData();
    // Links such as …/#entry-12 open that entry directly.
    const openFromHash = () => {
      const linked = Number(location.hash.match(/^#entry-(\d+)$/)?.[1]);
      if (linked && linked !== state.selectedId) openDetail(linked);
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
  } catch (err) {
    els.count.textContent = `Could not load the database: ${err.message}`;
  }
})();
