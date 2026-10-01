/**
 * nexus.js — parsing Nexus Mods URLs and fetching mod details from the v1 API.
 *
 * The v1 REST API is keyed on (game domain, numeric mod id). For Stardew Valley
 * the game domain is "stardewvalley". There is no official search-by-name
 * endpoint, which is why pasting a URL is the reliable way to add a mod.
 */

const GAME_DOMAIN = 'stardewvalley';
const API_BASE = 'https://api.nexusmods.com/v1';

/**
 * Pull a numeric mod id out of whatever the user pasted.
 *
 * Accepts:
 *   https://www.nexusmods.com/stardewvalley/mods/7286
 *   https://nexusmods.com/stardewvalley/mods/7286?tab=files
 *   nexusmods.com/stardewvalley/mods/7286
 *   7286
 *
 * Returns { modId, gameDomain } or throws with a readable message.
 */
function parseModInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('Nothing was pasted.');

  // A bare number is treated as a Stardew Valley mod id.
  if (/^\d+$/.test(text)) {
    return { modId: Number(text), gameDomain: GAME_DOMAIN };
  }

  // Otherwise look for the /<game>/mods/<id> shape anywhere in the string.
  const match = text.match(/nexusmods\.com\/([a-z0-9]+)\/mods\/(\d+)/i);
  if (match) {
    return { gameDomain: match[1].toLowerCase(), modId: Number(match[2]) };
  }

  throw new Error(
    'That does not look like a Nexus mod link. Paste something like ' +
      'https://www.nexusmods.com/stardewvalley/mods/7286 — or just the number.'
  );
}

/**
 * Fetch mod details. Returns the raw JSON object the API sends back.
 * Throws with a readable message on auth failure, rate limiting or a missing mod.
 */
async function fetchMod({ apiKey, modId, gameDomain = GAME_DOMAIN }) {
  if (!apiKey) throw new Error('No Nexus API key is saved yet.');

  const url = `${API_BASE}/games/${gameDomain}/mods/${modId}.json`;
  const response = await fetch(url, {
    headers: {
      apikey: apiKey,
      accept: 'application/json',
      'application-name': 'stardew-mod-tracker',
      'application-version': '0.1.0',
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('Nexus rejected the API key. Check it in Settings, or generate a new one.');
  }
  if (response.status === 404) {
    throw new Error(`No mod with id ${modId} exists for ${gameDomain}.`);
  }
  if (response.status === 429) {
    throw new Error('Nexus rate limit reached. Try again later.');
  }
  if (!response.ok) {
    throw new Error(`Nexus returned ${response.status}.`);
  }

  return response.json();
}

/** Map the API's response onto the columns in the mods table. */
function toModRow(data, { modId, gameDomain = GAME_DOMAIN } = {}) {
  return {
    nexus_mod_id: data.mod_id ?? modId,
    display_name: data.name ?? `Mod ${modId}`,
    author: data.author ?? data.uploaded_by ?? null,
    summary: data.summary ?? null,
    description_full: data.description ?? null,
    nexus_category: data.category_name ?? null,
    picture_url: data.picture_url ?? null,
    version_latest: data.version ?? null,
    nexus_url:
      data.mod_page_uri ?? `https://www.nexusmods.com/${gameDomain}/mods/${data.mod_id ?? modId}`,
  };
}

module.exports = { parseModInput, fetchMod, toModRow, GAME_DOMAIN };
