/**
 * db.js — SQLite storage using node:sqlite, built into Node 22+.
 *
 * No native module to compile, so nothing can mismatch your Node version.
 *
 * The database file lives outside the source folder by default so it is never
 * committed to git and survives you moving the code around.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.homedir(), '.stardew-mod-tracker');
const DB_PATH = process.env.SMT_DB_PATH || path.join(DATA_DIR, 'mods.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH, { allowUnknownNamedParameters: true });

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Apply the schema. Every statement in schema.sql is idempotent.
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// A column added after the first release. Older databases will not have it.
const columns = db.prepare('PRAGMA table_info(mods)').all().map((c) => c.name);
if (!columns.includes('nexus_url')) {
  db.exec('ALTER TABLE mods ADD COLUMN nexus_url TEXT');
  db.exec('DROP VIEW IF EXISTS mods_view');
  db.exec(`CREATE VIEW mods_view AS
    SELECT m.*,
      (SELECT group_concat(t.name, ', ')
         FROM mod_tags mt JOIN tags t ON t.id = mt.tag_id
        WHERE mt.mod_id = m.id) AS tag_names
    FROM mods m`);
}

/**
 * Run a function inside a transaction. node:sqlite has no db.transaction()
 * helper, so this wraps BEGIN / COMMIT / ROLLBACK by hand.
 * The function must be synchronous — no await inside.
 */
function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

/** node:sqlite returns BigInt rowids; convert to a plain number. */
function toNumber(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

/**
 * Insert a mod fetched from Nexus, or update the cached metadata if a row for
 * that nexus_mod_id already exists. Never touches install state, notes or tags.
 */
function upsertNexusMod(row) {
  const existing = db
    .prepare('SELECT id FROM mods WHERE nexus_mod_id = ?')
    .get(row.nexus_mod_id);

  // node:sqlite binds only null, not undefined — normalise every field.
  // Named-parameter keys must keep their leading colon.
  const values = {
    ':nexus_mod_id': row.nexus_mod_id ?? null,
    ':display_name': row.display_name ?? null,
    ':author': row.author ?? null,
    ':summary': row.summary ?? null,
    ':description_full': row.description_full ?? null,
    ':nexus_category': row.nexus_category ?? null,
    ':picture_url': row.picture_url ?? null,
    ':version_latest': row.version_latest ?? null,
    ':nexus_url': row.nexus_url ?? null,
  };

  if (existing) {
    db.prepare(
      `UPDATE mods SET
         display_name = :display_name,
         author = :author,
         summary = :summary,
         description_full = :description_full,
         nexus_category = :nexus_category,
         picture_url = :picture_url,
         version_latest = :version_latest,
         nexus_url = :nexus_url,
         nexus_fetched_at = datetime('now')
       WHERE id = :id`
    ).run({ ...values, ':id': toNumber(existing.id) });
    return toNumber(existing.id);
  }

  const result = db
    .prepare(
      `INSERT INTO mods
         (nexus_mod_id, display_name, author, summary, description_full,
          nexus_category, picture_url, version_latest, nexus_url,
          nexus_fetched_at, source)
       VALUES
         (:nexus_mod_id, :display_name, :author, :summary, :description_full,
          :nexus_category, :picture_url, :version_latest, :nexus_url,
          datetime('now'), 'manual')`
    )
    .run(values);

  return toNumber(result.lastInsertRowid);
}

function getMod(id) {
  return db.prepare('SELECT * FROM mods_view WHERE id = ?').get(id);
}

/**
 * Mods the folder scanner identified on disk that carry a Nexus id but have
 * never had their Nexus metadata fetched — so no thumbnail, no summary from
 * Nexus, no latest version to compare against.
 *
 * Only unfetched rows are returned, so a second scan makes no network calls.
 */
function listModsNeedingNexusFetch() {
  return db
    .prepare(
      `SELECT id, nexus_mod_id, display_name
         FROM mods
        WHERE nexus_mod_id IS NOT NULL
          AND nexus_fetched_at IS NULL
        ORDER BY display_name COLLATE NOCASE`
    )
    .all();
}

/**
 * List mods, optionally filtered.
 *
 * @param {object} opts
 * @param {string} opts.search      free text matched against name, author, summary, notes, tags
 * @param {number[]} opts.tagIds    mods must carry EVERY tag listed
 * @param {string} opts.status      all | installed | tried | interested
 * @param {string} opts.sort        name | added | updated
 */
function listMods(opts = {}) {
  const { search = '', tagIds = [], status = 'all', sort = 'name' } = opts;

  const where = [];
  const params = {};

  if (search.trim()) {
    params[':q'] = search.trim();
    where.push(`(
      display_name LIKE '%' || :q || '%' OR
      author       LIKE '%' || :q || '%' OR
      summary      LIKE '%' || :q || '%' OR
      user_notes   LIKE '%' || :q || '%' OR
      tag_names    LIKE '%' || :q || '%'
    )`);
  }

  if (status === 'installed') where.push('currently_installed = 1');
  else if (status === 'tried') where.push('in_history = 1');
  else if (status === 'interested') where.push('in_history = 0');

  if (tagIds.length) {
    // Require ALL selected tags, not any.
    const placeholders = tagIds.map((_, i) => `:tag${i}`).join(', ');
    tagIds.forEach((id, i) => {
      params[`:tag${i}`] = id;
    });
    where.push(`(
      SELECT COUNT(DISTINCT mt.tag_id) FROM mod_tags mt
       WHERE mt.mod_id = mods_view.id AND mt.tag_id IN (${placeholders})
    ) = ${tagIds.length}`);
  }

  let orderBy = 'display_name COLLATE NOCASE';
  if (sort === 'added') orderBy = 'added_at DESC';
  else if (sort === 'updated') orderBy = 'nexus_fetched_at DESC';

  // Exact prefix matches float to the top when searching.
  const prefixRank = search.trim()
    ? `CASE WHEN display_name LIKE :q || '%' THEN 0 ELSE 1 END, `
    : '';

  const sql = `SELECT * FROM mods_view
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${prefixRank}${orderBy}`;

  return db.prepare(sql).all(params);
}

function updateNotes(id, notes) {
  db.prepare('UPDATE mods SET user_notes = ? WHERE id = ?').run(notes ?? '', id);
}

function deleteMod(id) {
  db.prepare('DELETE FROM mods WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const TAG_COLORS = ['#7c5cff', '#4caf50', '#ff8a4c', '#39a0ed', '#e05d9b', '#d4a017'];

function listTags() {
  return db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM mod_tags mt WHERE mt.tag_id = t.id) AS mod_count
         FROM tags t ORDER BY t.name COLLATE NOCASE`
    )
    .all();
}

function createTag(name, color) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('A tag needs a name.');

  const existing = db.prepare('SELECT * FROM tags WHERE name = ? COLLATE NOCASE').get(clean);
  if (existing) return existing;

  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM tags').get().n);
  const chosen = color || TAG_COLORS[count % TAG_COLORS.length];

  const result = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(clean, chosen);
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(toNumber(result.lastInsertRowid));
}

function renameTag(id, name) {
  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(String(name).trim(), id);
}

function deleteTag(id) {
  // ON DELETE CASCADE clears the pairings in mod_tags.
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
}

function addTagToMod(modId, tagId) {
  db.prepare('INSERT OR IGNORE INTO mod_tags (mod_id, tag_id) VALUES (?, ?)').run(modId, tagId);
}

function removeTagFromMod(modId, tagId) {
  db.prepare('DELETE FROM mod_tags WHERE mod_id = ? AND tag_id = ?').run(modId, tagId);
}

function getTagsForMod(modId) {
  return db
    .prepare(
      `SELECT t.* FROM tags t JOIN mod_tags mt ON mt.tag_id = t.id
        WHERE mt.mod_id = ? ORDER BY t.name COLLATE NOCASE`
    )
    .all(modId);
}

module.exports = {
  db,
  DB_PATH,
  transaction,
  toNumber,
  getSetting,
  setSetting,
  upsertNexusMod,
  getMod,
  listMods,
  listModsNeedingNexusFetch,
  updateNotes,
  deleteMod,
  listTags,
  createTag,
  renameTag,
  deleteTag,
  addTagToMod,
  removeTagFromMod,
  getTagsForMod,
};
