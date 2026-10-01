-- Stardew Mod Tracker — database schema
-- SQLite. Run once at app startup; every statement is idempotent.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- mods — one row per mod you care about, installed or not.
-- A row is NEVER deleted. Uninstalling only flips currently_installed to 0.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mods (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Identity ---------------------------------------------------------------
  nexus_mod_id        INTEGER UNIQUE,   -- from the Nexus URL or UpdateKeys
  unique_id           TEXT UNIQUE,      -- manifest.json UniqueID, e.g. Rafseazz.RidgesideVillage
  display_name        TEXT NOT NULL,

  -- Cached Nexus metadata (fetched once, refreshed on demand) ---------------
  author              TEXT,
  summary             TEXT,
  description_full    TEXT,
  nexus_category      TEXT,             -- Nexus's taxonomy. Kept apart from your tags.
  picture_url         TEXT,
  version_latest      TEXT,             -- newest version on Nexus
  nexus_fetched_at    TEXT,             -- ISO timestamp of last successful fetch

  -- Local install state (written by the folder scanner) ---------------------
  version_installed   TEXT,             -- from the installed manifest.json
  folder_path         TEXT,             -- relative path inside the Mods folder
  currently_installed INTEGER NOT NULL DEFAULT 0,  -- checkbox 1
  in_history          INTEGER NOT NULL DEFAULT 0,  -- checkbox 2, never flips back to 0
  first_seen          TEXT,             -- first scan that found it on disk
  last_seen           TEXT,             -- most recent scan that found it on disk

  -- Yours ------------------------------------------------------------------
  user_notes          TEXT NOT NULL DEFAULT '',
  source              TEXT NOT NULL DEFAULT 'manual',  -- manual | scan | index
  added_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mods_name      ON mods(display_name);
CREATE INDEX IF NOT EXISTS idx_mods_installed ON mods(currently_installed);
CREATE INDEX IF NOT EXISTS idx_mods_history   ON mods(in_history);

-- ---------------------------------------------------------------------------
-- tags — your labels. Independent of any mod, so renaming is a one-row edit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- mod_tags — which tags are on which mods. One row per pairing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mod_tags (
  mod_id INTEGER NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (mod_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_mod_tags_tag ON mod_tags(tag_id);

-- ---------------------------------------------------------------------------
-- settings — key/value. Holds the Nexus API key and the Mods folder path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- A convenience view: every mod with its tags rolled up and the update flag
-- already computed, so the UI can select straight from it.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS mods_view;
CREATE VIEW mods_view AS
SELECT
  m.*,
  (SELECT group_concat(t.name, ', ')
     FROM mod_tags mt JOIN tags t ON t.id = mt.tag_id
    WHERE mt.mod_id = m.id
    ORDER BY t.name) AS tag_names
FROM mods m;
