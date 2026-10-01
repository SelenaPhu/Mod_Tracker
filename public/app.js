/* app.js — the browser side. Plain JS, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  tags: [],
  activeTagIds: new Set(),
  search: '',
  status: 'all',
  sort: 'name',
};

/* ------------------------------------------------------------------ utils */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Debounce so typing in the search box doesn't fire a request per keystroke. */
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* --------------------------------------------------------------- settings */

async function loadSettings() {
  const settings = await api('GET', '/api/settings');
  $('#db-path').textContent = `Database: ${settings.dbPath}`;
  $('#mods-folder').value = settings.modsFolder;
  // Show the setup panel automatically until a key exists.
  $('#setup').classList.toggle('hidden', settings.hasApiKey);
  return settings;
}

$('#settings-btn').addEventListener('click', () => {
  $('#setup').classList.toggle('hidden');
});

$('#save-settings').addEventListener('click', async () => {
  await api('POST', '/api/settings', {
    apiKey: $('#api-key').value,
    modsFolder: $('#mods-folder').value,
  });
  $('#api-key').value = '';
  await loadSettings();
  $('#setup').classList.add('hidden');
});

/* ------------------------------------------------------------------- scan */

function renderScanResult(result) {
  const box = $('#scan-result');
  const lines = [];

  lines.push(
    `<p><strong>${result.foundOnDisk}</strong> mod${result.foundOnDisk === 1 ? '' : 's'} found on disk` +
      ` · <strong>${result.withNexusId}</strong> with a Nexus id` +
      (result.contentPacks ? ` · ${result.contentPacks} content pack${result.contentPacks === 1 ? '' : 's'}` : '') +
      `</p>`
  );

  const group = (label, items) => {
    if (!items || !items.length) return '';
    const shown = items.slice(0, 12).map((n) => `<li>${n}</li>`).join('');
    const more = items.length > 12 ? `<li class="muted">…and ${items.length - 12} more</li>` : '';
    return `<div class="scan-group"><h4>${label} (${items.length})</h4><ul>${shown}${more}</ul></div>`;
  };

  if (result.metadataFetched && result.metadataFetched.length) {
    lines.push(
      `<p class="muted small">Fetched artwork and details from Nexus for ` +
        `<strong>${result.metadataFetched.length}</strong> mod${result.metadataFetched.length === 1 ? '' : 's'}.</p>`
    );
  }

  if (result.metadataSkipped) {
    lines.push(
      `<p class="muted small">Add your Nexus API key in Settings to fetch artwork and summaries for scanned mods.</p>`
    );
  }

  lines.push(group('New to the tracker', result.newToTracker));
  lines.push(group('Back in your folder', result.reinstalled));
  lines.push(group('In history, not installed now', result.notInstalled));
  lines.push(group('Could not fetch from Nexus', result.metadataFailed));
  lines.push(group('Manifests that could not be read', result.manifestErrors));

  if (result.skippedDisabled) {
    lines.push(
      `<p class="muted small">${result.skippedDisabled} disabled folder${result.skippedDisabled === 1 ? '' : 's'} skipped (name starts with . or _).</p>`
    );
  }

  box.innerHTML = lines.join('');
  box.classList.remove('hidden');
}

$('#scan-btn').addEventListener('click', async () => {
  const btn = $('#scan-btn');
  const status = $('#scan-status');

  btn.disabled = true;
  status.textContent = 'Scanning…';
  $('#scan-result').classList.add('hidden');

  try {
    const result = await api('POST', '/api/scan', {
      modsFolder: $('#mods-folder').value.trim() || undefined,
    });
    status.textContent = result.modsFolder;
    renderScanResult(result);
    await loadMods();
  } catch (err) {
    status.textContent = '';
    const box = $('#scan-result');
    box.innerHTML = `<p class="error">${err.message}</p>`;
    box.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------- tags */

async function loadTags() {
  state.tags = await api('GET', '/api/tags');

  const filters = $('#tag-filters');
  filters.innerHTML = '';
  for (const tag of state.tags) {
    const el = document.createElement('button');
    const active = state.activeTagIds.has(tag.id);
    el.className = 'tag' + (active ? ' active' : '');
    el.style.borderColor = tag.color;
    el.style.background = active ? tag.color : 'transparent';
    el.style.color = active ? '#fff' : tag.color;
    el.textContent = `${tag.name} (${tag.mod_count})`;
    el.addEventListener('click', () => {
      if (state.activeTagIds.has(tag.id)) state.activeTagIds.delete(tag.id);
      else state.activeTagIds.add(tag.id);
      loadTags();
      loadMods();
    });

    // A small delete control, so tags created by mistake can be removed.
    const del = document.createElement('span');
    del.className = 'x del';
    del.textContent = '×';
    del.title = `Delete the tag "${tag.name}" from every mod`;
    del.addEventListener('click', async (e) => {
      e.stopPropagation(); // do not also toggle the filter
      const used = Number(tag.mod_count) || 0;
      const warning = used
        ? `Delete the tag "${tag.name}"? It is currently on ${used} mod${used === 1 ? '' : 's'}, and will be removed from ${used === 1 ? 'it' : 'them'}.`
        : `Delete the tag "${tag.name}"?`;
      if (!confirm(warning)) return;

      await api('DELETE', `/api/tags/${tag.id}`);
      state.activeTagIds.delete(tag.id);
      await loadTags();
      await loadMods();
    });
    el.appendChild(del);

    filters.appendChild(el);
  }

  $('#tag-options').innerHTML = state.tags
    .map((t) => `<option value="${t.name}"></option>`)
    .join('');
}

/* ------------------------------------------------------------------- mods */

function renderCard(mod) {
  const node = $('#card-template').content.cloneNode(true);
  const card = $('.card', node);

  const img = $('.thumb', node);
  if (mod.picture_url) {
    img.src = mod.picture_url;
    img.alt = mod.display_name;
  } else {
    img.remove();
  }

  if (mod.badge && mod.badge.show) {
    const badge = $('.badge', node);
    badge.textContent = mod.badge.label;
    badge.style.background = mod.badge.color;
    badge.classList.remove('hidden');
  }

  $('.name', node).textContent = mod.display_name;
  $('.author', node).textContent = [mod.author, mod.nexus_category]
    .filter(Boolean)
    .join(' · ');
  $('.summary', node).textContent = mod.summary || '';

  const history = $('[data-kind="history"]', node);
  const installed = $('[data-kind="installed"]', node);
  if (mod.in_history) history.classList.add('on');
  if (mod.currently_installed) installed.classList.add('on');

  const versions = [];
  if (mod.version_installed) versions.push(`installed ${mod.version_installed}`);
  if (mod.version_latest) versions.push(`latest ${mod.version_latest}`);
  if (mod.badge && mod.badge.detail) versions.push(mod.badge.detail);
  $('.versions', node).textContent = versions.join(' · ');

  // Tags on this card
  const tagRow = $('.card-tags', node);
  const names = (mod.tag_names || '').split(', ').filter(Boolean);
  for (const name of names) {
    const tag = state.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const el = document.createElement('span');
    el.className = 'tag active';
    el.style.background = tag ? tag.color : '#555';
    el.style.borderColor = tag ? tag.color : '#555';
    el.innerHTML = `${name}<span class="x">×</span>`;
    $('.x', el).addEventListener('click', async () => {
      if (!tag) return;
      await api('DELETE', `/api/mods/${mod.id}/tags/${tag.id}`);
      await loadTags();
      await loadMods();
    });
    tagRow.appendChild(el);
  }

  // Add a tag by typing a name — creates it if it doesn't exist yet
  const tagInput = $('.tag-input', node);
  tagInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !tagInput.value.trim()) return;
    await api('POST', `/api/mods/${mod.id}/tags`, { name: tagInput.value.trim() });
    tagInput.value = '';
    await loadTags();
    await loadMods();
  });

  // Notes save on blur
  const notes = $('.notes', node);
  notes.value = mod.user_notes || '';
  notes.addEventListener('blur', async () => {
    if (notes.value === (mod.user_notes || '')) return;
    await api('PUT', `/api/mods/${mod.id}/notes`, { notes: notes.value });
    mod.user_notes = notes.value;
  });

  const link = $('.nexus-link', node);
  if (mod.nexus_url) link.href = mod.nexus_url;
  else link.remove();

  $('.refresh', node).addEventListener('click', async (e) => {
    e.target.textContent = '…';
    try {
      await api('POST', `/api/mods/${mod.id}/refresh`);
      await loadMods();
    } catch (err) {
      alert(err.message);
      e.target.textContent = 'Refresh';
    }
  });

  $('.remove', node).addEventListener('click', async () => {
    if (!confirm(`Remove "${mod.display_name}" from your list? Your notes and tags for it go too.`))
      return;
    await api('DELETE', `/api/mods/${mod.id}`);
    await loadTags();
    await loadMods();
  });

  return card;
}

async function loadMods() {
  const params = new URLSearchParams({
    search: state.search,
    status: state.status,
    sort: state.sort,
    tags: [...state.activeTagIds].join(','),
  });

  const mods = await api('GET', `/api/mods?${params}`);
  const grid = $('#grid');
  grid.innerHTML = '';
  for (const mod of mods) grid.appendChild(renderCard(mod));

  $('#count').textContent = mods.length
    ? `${mods.length} mod${mods.length === 1 ? '' : 's'}`
    : '';
  $('#empty').classList.toggle('hidden', mods.length > 0);
}

/* ---------------------------------------------------------------- add mod */

async function addMod() {
  const input = $('#add-input');
  const error = $('#add-error');
  const value = input.value.trim();
  if (!value) return;

  error.classList.add('hidden');
  $('#add-btn').disabled = true;

  try {
    await api('POST', '/api/mods', { input: value });
    input.value = '';
    await loadMods();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  } finally {
    $('#add-btn').disabled = false;
  }
}

$('#add-btn').addEventListener('click', addMod);
$('#add-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addMod();
});

/* --------------------------------------------------------------- controls */

$('#search').addEventListener(
  'input',
  debounce((e) => {
    state.search = e.target.value;
    loadMods();
  }, 200)
);

$('#status').addEventListener('change', (e) => {
  state.status = e.target.value;
  loadMods();
});

$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  loadMods();
});

/* ------------------------------------------------------------------- boot */

(async function init() {
  await loadSettings();
  await loadTags();
  await loadMods();
})();
