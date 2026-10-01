/**
 * scanner.js — walks the Mods folder, reads every manifest.json, and updates
 * the database to match what is actually on disk.
 *
 * SMAPI layout: each mod lives in its own subfolder containing a manifest.json.
 * Those subfolders can be nested inside organising folders, so the walk recurses
 * until it finds a manifest rather than only listing the top level.
 *
 * The scan NEVER deletes a row. Uninstalling a mod only flips
 * currently_installed to 0; in_history, your notes and your tags all survive.
 */

const fs = require('fs');
const path = require('path');

const { db, transaction } = require('./db');

const MAX_DEPTH = 6;

/** Folders SMAPI ignores, and ones that are never mods. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vortex_backup']);

function isDisabled(name) {
  // SMAPI treats a folder starting with "." as disabled. Vortex/manual users
  // also commonly prefix with "_" to turn a mod off without deleting it.
  return name.startsWith('.') || name.startsWith('_');
}

/**
 * Recursively find every folder containing a manifest.json.
 * Stops descending once a manifest is found — a mod's own subfolders
 * (assets, i18n) are not separate mods. Content packs bundled INSIDE a mod
 * folder are the exception and are picked up by the nested check below.
 */
function findManifests(rootDir, currentDir = rootDir, depth = 0, found = []) {
  if (depth > MAX_DEPTH) return found;

  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return found; // unreadable folder — skip it rather than crashing the scan
  }

  const hasManifest = entries.some((e) => e.isFile() && e.name.toLowerCase() === 'manifest.json');

  if (hasManifest) {
    found.push(path.join(currentDir, 'manifest.json'));
    // A mod folder can still contain bundled content packs one level down.
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(currentDir, entry.name);
      const childManifest = path.join(child, 'manifest.json');
      if (fs.existsSync(childManifest)) {
        findManifests(rootDir, child, depth + 1, found);
      }
    }
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    findManifests(rootDir, path.join(currentDir, entry.name), depth + 1, found);
  }

  return found;
}

/**
 * Parse a manifest.json. SMAPI accepts JSON with comments and trailing commas,
 * and a fair number of published mods use both, so strip them before parsing.
 */
function readManifest(file) {
  let text = fs.readFileSync(file, 'utf8');

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  const cleaned = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g, (m) =>
      m.startsWith('"') ? m : ''
    )
    .replace(/,(\s*[}\]])/g, '$1');

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`${path.basename(path.dirname(file))}: ${err.message}`);
  }
}

/**
 * Pull the Nexus mod id out of UpdateKeys.
 * Formats seen in the wild: "Nexus:2400", "nexus:2400", "Nexus:2400@GeodeCrusher".
 */
function nexusIdFromUpdateKeys(updateKeys) {
  if (!Array.isArray(updateKeys)) return null;

  for (const key of updateKeys) {
    if (typeof key !== 'string') continue;
    const match = key.trim().match(/^nexus\s*:\s*(\d+)/i);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Normalise one manifest into the fields the scan cares about. */
function toScanned(manifestFile, rootDir) {
  const data = readManifest(manifestFile);
  const folder = path.dirname(manifestFile);

  return {
    unique_id: typeof data.UniqueID === 'string' ? data.UniqueID.trim() : null,
    display_name: (data.Name || path.basename(folder)).trim(),
    author: typeof data.Author === 'string' ? data.Author.trim() : null,
    summary: typeof data.Description === 'string' ? data.Description.trim() : null,
    version_installed: data.Version ? String(data.Version).trim() : null,
    nexus_mod_id: nexusIdFromUpdateKeys(data.UpdateKeys),
    folder_path: path.relative(rootDir, folder) || path.basename(folder),
    is_content_pack: Boolean(data.ContentPackFor),
    disabled: folder
      .split(path.sep)
      .some((segment) => isDisabled(segment) && folder !== rootDir),
  };
}

/* -------------------------------------------------------------------------- */
/* Matching a scanned mod to an existing row                                  */
/* -------------------------------------------------------------------------- */

function findExistingRow(scanned) {
  // 1. UniqueID is the strongest match — it is stable across versions.
  if (scanned.unique_id) {
    const byUnique = db
      .prepare('SELECT * FROM mods WHERE unique_id = ? COLLATE NOCASE')
      .get(scanned.unique_id);
    if (byUnique) return byUnique;
  }

  // 2. Nexus id — catches mods you added by pasting a link before installing.
  if (scanned.nexus_mod_id) {
    const byNexus = db
      .prepare('SELECT * FROM mods WHERE nexus_mod_id = ?')
      .get(scanned.nexus_mod_id);
    if (byNexus) return byNexus;
  }

  // 3. Exact name, last resort, and only for rows with no identity of their own
  //    (so a manual row for "Ridgeside Village" links up rather than duplicating).
  const byName = db
    .prepare(
      'SELECT * FROM mods WHERE display_name = ? COLLATE NOCASE AND unique_id IS NULL'
    )
    .get(scanned.display_name);

  return byName || null;
}

/* -------------------------------------------------------------------------- */
/* The scan                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Scan the Mods folder and reconcile the database with it.
 *
 * @param {string} modsFolder absolute path to the Stardew Valley Mods folder
 * @returns {object} a summary: counts, plus lists of what changed
 */
function scanModsFolder(modsFolder) {
  if (!modsFolder || !modsFolder.trim()) {
    throw new Error('No Mods folder is set. Add the path in Settings first.');
  }

  const rootDir = path.resolve(modsFolder.trim());

  if (!fs.existsSync(rootDir)) {
    throw new Error(`That folder does not exist: ${rootDir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new Error(`That path is a file, not a folder: ${rootDir}`);
  }

  const manifestFiles = findManifests(rootDir);

  const scanned = [];
  const errors = [];
  for (const file of manifestFiles) {
    try {
      scanned.push(toScanned(file, rootDir));
    } catch (err) {
      errors.push(err.message);
    }
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const added = [];
  const stillInstalled = [];
  const reinstalled = [];

  const run = transaction(() => {
    // Everything starts as not-installed; the loop below re-marks what it finds.
    // in_history is deliberately untouched — it only ever goes from 0 to 1.
    db.prepare('UPDATE mods SET currently_installed = 0').run();

    for (const mod of scanned) {
      if (mod.disabled) continue; // folder is prefixed with . or _ — SMAPI won't load it

      const existing = findExistingRow(mod);

      if (existing) {
        const wasInHistory = existing.in_history === 1;

        db.prepare(
          `UPDATE mods SET
             unique_id           = COALESCE(unique_id, @unique_id),
             nexus_mod_id        = COALESCE(nexus_mod_id, @nexus_mod_id),
             author              = COALESCE(author, @author),
             summary             = COALESCE(summary, @summary),
             version_installed   = @version_installed,
             folder_path         = @folder_path,
             currently_installed = 1,
             in_history          = 1,
             first_seen          = COALESCE(first_seen, @now),
             last_seen           = @now
           WHERE id = @id`
        ).run({ ...mod, id: existing.id, now });

        if (wasInHistory) stillInstalled.push(mod.display_name);
        else reinstalled.push(mod.display_name);
      } else {
        db.prepare(
          `INSERT INTO mods
             (unique_id, nexus_mod_id, display_name, author, summary,
              version_installed, folder_path, currently_installed, in_history,
              first_seen, last_seen, source)
           VALUES
             (@unique_id, @nexus_mod_id, @display_name, @author, @summary,
              @version_installed, @folder_path, 1, 1, @now, @now, 'scan')`
        ).run({ ...mod, now });

        added.push(mod.display_name);
      }
    }
  });

  run();

  // Anything in history that this scan did not find is no longer installed.
  const nowMissing = db
    .prepare(
      `SELECT display_name FROM mods
        WHERE in_history = 1 AND currently_installed = 0
        ORDER BY display_name COLLATE NOCASE`
    )
    .all()
    .map((r) => r.display_name);

  return {
    modsFolder: rootDir,
    scannedAt: now,
    foundOnDisk: scanned.length,
    contentPacks: scanned.filter((m) => m.is_content_pack).length,
    skippedDisabled: scanned.filter((m) => m.disabled).length,
    withNexusId: scanned.filter((m) => m.nexus_mod_id).length,
    //newToTracker: added,
    reinstalled,
    stillInstalled: stillInstalled.length,
    notInstalled: nowMissing,
    manifestErrors: errors,
  };
}

module.exports = {
  scanModsFolder,
  findManifests,
  readManifest,
  nexusIdFromUpdateKeys,
};
