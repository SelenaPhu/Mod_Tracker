/**
 * server.js — the local web server.
 *
 * Run `npm start`, then open http://localhost:3000 in your browser.
 * Nothing is exposed to the network: the server binds to localhost only.
 */

const express = require('express');
const path = require('path');

const store = require('./db');
const nexus = require('./nexus');
const { getUpdateBadge } = require('./version');
const { scanModsFolder } = require('./scanner');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/** Attach the computed update badge to a mod row before sending it out. */
function decorate(mod) {
  return { ...mod, badge: getUpdateBadge(mod) };
}

/** Wrap an async route so a thrown error becomes a clean JSON response. */
function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

app.get(
  '/api/settings',
  route(async (req, res) => {
    const key = store.getSetting('nexus_api_key');
    res.json({
      // Never send the key itself back to the browser — only whether one is saved.
      hasApiKey: Boolean(key),
      modsFolder: store.getSetting('mods_folder') || '',
      dbPath: store.DB_PATH,
    });
  })
);

app.post(
  '/api/settings',
  route(async (req, res) => {
    const { apiKey, modsFolder } = req.body;
    if (typeof apiKey === 'string' && apiKey.trim()) {
      store.setSetting('nexus_api_key', apiKey.trim());
    }
    if (typeof modsFolder === 'string') {
      store.setSetting('mods_folder', modsFolder.trim());
    }
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Folder scan
// ---------------------------------------------------------------------------

/**
 * Walk the Mods folder and reconcile the database with what is on disk, then
 * fill in Nexus metadata (thumbnail, summary, latest version) for any scanned
 * mod that has a Nexus id but has never been fetched.
 *
 * The scan itself is synchronous because it runs inside a SQLite transaction,
 * and better-sqlite3 transactions cannot contain an await. So the network work
 * happens here, afterwards, one mod at a time.
 */
app.post(
  '/api/scan',
  route(async (req, res) => {
    const folder = req.body.modsFolder || store.getSetting('mods_folder');
    const result = scanModsFolder(folder);

    // Remember a folder passed in directly, so the next scan needs no argument.
    if (req.body.modsFolder) store.setSetting('mods_folder', req.body.modsFolder.trim());
    store.setSetting('last_scan_at', result.scannedAt);

    // --- fill in missing Nexus metadata -------------------------------------
    const apiKey = store.getSetting('nexus_api_key');
    const pending = store.listModsNeedingNexusFetch();

    const fetched = [];
    const failed = [];

    if (apiKey && pending.length) {
      for (const row of pending) {
        try {
          const data = await nexus.fetchMod({ apiKey, modId: row.nexus_mod_id });
          store.upsertNexusMod(nexus.toModRow(data, { modId: row.nexus_mod_id }));
          fetched.push(row.display_name);
        } catch (err) {
          failed.push(`${row.display_name}: ${err.message}`);
          // A bad key or a rate limit will fail for every remaining mod too,
          // so stop rather than burning through the list.
          if (/API key|rate limit/i.test(err.message)) break;
        }
      }
    }

    res.json({
      ...result,
      needingMetadata: pending.length,
      metadataFetched: fetched,
      metadataFailed: failed,
      metadataSkipped: !apiKey && pending.length > 0,
    });
  })
);

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

app.get(
  '/api/mods',
  route(async (req, res) => {
    const tagIds = String(req.query.tags || '')
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);

    const mods = store.listMods({
      search: req.query.search || '',
      status: req.query.status || 'all',
      sort: req.query.sort || 'name',
      tagIds,
    });

    res.json(mods.map(decorate));
  })
);

/** Paste a Nexus link (or a bare mod id) and get a fully populated row back. */
app.post(
  '/api/mods',
  route(async (req, res) => {
    const apiKey = store.getSetting('nexus_api_key');
    if (!apiKey) throw new Error('Add your Nexus API key in Settings first.');

    const { modId, gameDomain } = nexus.parseModInput(req.body.input);
    const data = await nexus.fetchMod({ apiKey, modId, gameDomain });
    const id = store.upsertNexusMod(nexus.toModRow(data, { modId, gameDomain }));

    res.json(decorate(store.getMod(id)));
  })
);

/** Re-fetch one mod's metadata from Nexus. */
app.post(
  '/api/mods/:id/refresh',
  route(async (req, res) => {
    const apiKey = store.getSetting('nexus_api_key');
    if (!apiKey) throw new Error('Add your Nexus API key in Settings first.');

    const mod = store.getMod(Number(req.params.id));
    if (!mod) throw new Error('No such mod.');
    if (!mod.nexus_mod_id) throw new Error('This mod has no Nexus id to refresh from.');

    const data = await nexus.fetchMod({ apiKey, modId: mod.nexus_mod_id });
    store.upsertNexusMod(nexus.toModRow(data, { modId: mod.nexus_mod_id }));

    res.json(decorate(store.getMod(mod.id)));
  })
);

app.put(
  '/api/mods/:id/notes',
  route(async (req, res) => {
    store.updateNotes(Number(req.params.id), req.body.notes);
    res.json(decorate(store.getMod(Number(req.params.id))));
  })
);

app.delete(
  '/api/mods/:id',
  route(async (req, res) => {
    store.deleteMod(Number(req.params.id));
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

app.get(
  '/api/tags',
  route(async (req, res) => {
    res.json(store.listTags());
  })
);

app.post(
  '/api/tags',
  route(async (req, res) => {
    res.json(store.createTag(req.body.name, req.body.color));
  })
);

app.put(
  '/api/tags/:id',
  route(async (req, res) => {
    store.renameTag(Number(req.params.id), req.body.name);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/tags/:id',
  route(async (req, res) => {
    store.deleteTag(Number(req.params.id));
    res.json({ ok: true });
  })
);

app.post(
  '/api/mods/:id/tags',
  route(async (req, res) => {
    const modId = Number(req.params.id);
    // Accept either an existing tag id or a new tag name.
    const tag = req.body.tagId
      ? { id: Number(req.body.tagId) }
      : store.createTag(req.body.name);

    store.addTagToMod(modId, tag.id);
    res.json(store.getTagsForMod(modId));
  })
);

app.delete(
  '/api/mods/:id/tags/:tagId',
  route(async (req, res) => {
    const modId = Number(req.params.id);
    store.removeTagFromMod(modId, Number(req.params.tagId));
    res.json(store.getTagsForMod(modId));
  })
);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Stardew Mod Tracker running at http://localhost:${PORT}`);
  console.log(`  Database: ${store.DB_PATH}\n`);
});
