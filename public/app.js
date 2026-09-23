const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  entries: [],
  options: null,
  selectedId: null,
  editingId: null,
  pollTimer: null,
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
  dialog: $('#entry-dialog'),
  form: $('#entry-form'),
  formError: $('#form-error'),
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

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z]+/g, '-');

const entryTitle = (e) =>
  e.title || e.attachment_name || (e.link && hostOf(e.link)) || (e.notes && e.notes.slice(0, 80)) || `Entry ${e.id}`;

const isBusy = (e) => e.analysis_status === 'pending' || e.analysis_status === 'processing';

function relevanceBadge(e) {
  if (isBusy(e)) return '<span class="badge badge-status">Analysing</span>';
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

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ---------- Loading and rendering ----------

async function loadOptions() {
  state.options = await api('/api/options');
  const { categories, regions, relevanceLevels, analysisEnabled } = state.options;

  const opts = (pairs) => pairs.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
  const categoryPairs = Object.entries(categories).map(([k, v]) => [k, `${k} – ${v}`]);

  els.category.insertAdjacentHTML('beforeend', opts(categoryPairs));
  els.region.insertAdjacentHTML('beforeend', opts(regions.map((r) => [r, r])));
  els.relevance.insertAdjacentHTML('beforeend', opts(relevanceLevels.map((r) => [r, r])) + '<option value="__unanalysed">Not yet analysed</option>');
  $('#f-category').innerHTML = opts(categoryPairs);
  $('#f-region').insertAdjacentHTML('beforeend', opts(regions.map((r) => [r, r])));

  $('#analysis-off').hidden = analysisEnabled;
  if (!analysisEnabled) {
    $('#form-analysis-hint').textContent = 'Automatic analysis is switched off until an API key is set.';
  }
}

async function loadEntries() {
  state.entries = await api('/api/entries');
  render();
  schedulePoll();
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

  const authorities = [...new Set(all.map((e) => e.authority).filter(Boolean))].sort();
  $('#authority-list').innerHTML = authorities.map((a) => `<option value="${escapeHtml(a)}">`).join('');

  const rows = filteredEntries();
  els.empty.hidden = all.length > 0;
  els.table.hidden = all.length === 0;
  els.count.hidden = all.length === 0;
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
  if (isBusy(e)) {
    return `<div class="analysis"><p class="analysis-pending"><span class="spinner"></span>
      Reading the ${e.attachment_name ? 'document' : e.link ? 'article' : 'question'} and writing a briefing…</p></div>`;
  }
  if (e.analysis_status === 'failed' || e.analysis_status === 'not_configured') {
    return `<div class="analysis"><div class="analysis-head"><h3>Briefing</h3></div>
      <p class="analysis-error">${escapeHtml(e.analysis_error || 'The analysis did not complete.')}</p></div>`;
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
    ? `<a href="/api/entries/${e.id}/attachment">${icons.doc}${escapeHtml(e.attachment_name)}</a>`
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
    </dl>`;

  $('#detail-analyse').disabled = isBusy(e) || !state.options.analysisEnabled;
}

// ---------- Polling for analysis results ----------

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (state.entries.some(isBusy)) {
    state.pollTimer = setTimeout(() => loadEntries().catch(() => schedulePoll()), 3000);
  }
}

// ---------- Detail drawer ----------

let lastFocus = null;

function openDetail(id) {
  lastFocus = document.activeElement;
  state.selectedId = id;
  renderDetail();
  els.detail.classList.add('open');
  els.detail.setAttribute('aria-hidden', 'false');
  $('.icon-btn', els.detail).focus();
}

function closeDetail() {
  state.selectedId = null;
  els.detail.classList.remove('open');
  els.detail.setAttribute('aria-hidden', 'true');
  lastFocus?.focus?.();
}

// ---------- Add / edit form ----------

function setSourceType(type) {
  els.form.querySelector(`input[name="source_type"][value="${type}"]`).checked = true;
  els.form.querySelectorAll('[data-source]').forEach((el) => { el.hidden = el.dataset.source !== type; });
  const isQuestion = type === 'question';
  $('[data-label-question]').textContent = isQuestion ? 'Question' : 'Title';
  $('[data-optional-title]').hidden = isQuestion;
  $('#f-title').placeholder = isQuestion
    ? 'e.g. What does the unitary proposal mean for staff pensions?'
    : 'A short title to help find this entry later';
}

function openForm(entry = null) {
  state.editingId = entry?.id ?? null;
  els.form.reset();
  els.formError.hidden = true;
  $('#form-title').textContent = entry ? `Edit entry ${entry.id}` : 'Add entry';
  $('#form-submit').textContent = entry ? 'Save changes' : 'Save entry';
  $('#reanalyse-wrap').hidden = !entry || !state.options.analysisEnabled;

  const f = els.form.elements;
  f.title.value = entry?.title ?? '';
  f.link.value = entry?.link ?? '';
  f.category.value = entry?.category ?? els.category.value ?? 'LGR';
  if (!f.category.value) f.category.value = 'LGR';
  f.date_entered.value = entry?.date_entered ?? todayIso();
  f.region.value = entry?.region ?? els.region.value ?? '';
  f.authority.value = entry?.authority ?? '';
  f.keywords.value = entry?.keywords ?? '';
  f.notes.value = entry?.notes ?? '';

  $('#current-file').hidden = !entry?.attachment_name;
  $('#current-file-name').textContent = entry?.attachment_name ?? '';

  setSourceType(entry ? (entry.attachment_name ? 'document' : entry.link ? 'link' : 'question') : 'link');
  els.dialog.showModal();
  (entry ? f.title : f.link).focus();
}

function closeForm() {
  els.dialog.close();
}

async function submitForm(event) {
  event.preventDefault();
  const f = els.form.elements;
  const type = f.source_type.value;
  const editing = state.entries.find((e) => e.id === state.editingId);

  const fd = new FormData();
  for (const name of ['title', 'category', 'date_entered', 'region', 'authority', 'keywords', 'notes']) {
    fd.append(name, f[name].value);
  }
  fd.append('link', type === 'link' ? f.link.value.trim() : '');
  const file = f.attachment.files[0];
  if (type === 'document' && file) fd.append('attachment', file);
  if (editing?.attachment_name && (type !== 'document' || f.remove_attachment.checked)) {
    fd.append('remove_attachment', 'true');
  }
  if (f.reanalyse.checked) fd.append('reanalyse', 'true');

  // Friendly checks before sending; the server checks again.
  const problems = [];
  if (type === 'link' && !f.link.value.trim()) problems.push('Enter the article link.');
  if (type === 'document' && !file && !(editing?.attachment_name && !f.remove_attachment.checked)) {
    problems.push('Choose a document to attach.');
  }
  if (type === 'question' && !f.title.value.trim()) problems.push('Type the question.');
  if (!f.region.value) problems.push('Choose a UNISON region or National.');
  if (problems.length) return showFormError(problems.join(' '));

  const submit = $('#form-submit');
  submit.disabled = true;
  try {
    const saved = await api(editing ? `/api/entries/${editing.id}` : '/api/entries', {
      method: editing ? 'PUT' : 'POST',
      body: fd,
    });
    closeForm();
    await loadEntries();
    toast(editing ? 'Changes saved.' : `Entry ${saved.id} added.${isBusy(saved) ? ' Analysing now…' : ''}`);
    openDetail(saved.id);
  } catch (err) {
    showFormError(err.message);
  } finally {
    submit.disabled = false;
  }
}

function showFormError(message) {
  els.formError.textContent = message;
  els.formError.hidden = false;
  els.formError.scrollIntoView({ block: 'nearest' });
}

// ---------- Events ----------

function bindEvents() {
  $('#add-entry').addEventListener('click', () => openForm());
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'add') openForm();
    if (action === 'close-detail') closeDetail();
    if (action === 'close-form') closeForm();
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
    if (event.key === 'Escape' && state.selectedId && !els.dialog.open) closeDetail();
  });

  els.form.addEventListener('submit', submitForm);
  els.form.querySelectorAll('input[name="source_type"]').forEach((radio) =>
    radio.addEventListener('change', () => setSourceType(radio.value)));

  $('#detail-edit').addEventListener('click', () => {
    const e = state.entries.find((x) => x.id === state.selectedId);
    if (e) openForm(e);
  });

  $('#detail-analyse').addEventListener('click', async () => {
    try {
      await api(`/api/entries/${state.selectedId}/analyse`, { method: 'POST' });
      await loadEntries();
      toast('Re-analysing entry…');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#detail-delete').addEventListener('click', async () => {
    const id = state.selectedId;
    if (!confirm(`Delete entry ${id}? This cannot be undone.`)) return;
    try {
      await api(`/api/entries/${id}`, { method: 'DELETE' });
      closeDetail();
      await loadEntries();
      toast(`Entry ${id} deleted.`);
    } catch (err) {
      toast(err.message);
    }
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
    await loadOptions();
    await loadEntries();
  } catch (err) {
    els.count.textContent = `Could not load the database: ${err.message}`;
  }
})();
