/**
 * version.js — semantic version comparison and the "update available" badge.
 *
 * SMAPI mods follow semantic versioning: MAJOR.MINOR.PATCH, optionally with a
 * prerelease tag (1.2.0-beta.3) and/or build metadata (1.2.0+build.55).
 * Build metadata is ignored when comparing, per the semver spec.
 * A prerelease sorts BEFORE its matching release: 1.2.0-beta < 1.2.0.
 */

/** Parse a version string into comparable parts. Returns null if unparseable. */
function parseVersion(raw) {
  if (typeof raw !== 'string') return null;

  // Tolerate a leading "v" and surrounding whitespace, both common in the wild.
  const cleaned = raw.trim().replace(/^v/i, '');
  const match = cleaned.match(
    /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/
  );
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** Compare two prerelease strings per semver rules. */
function comparePrerelease(a, b) {
  // No prerelease outranks a prerelease: 1.2.0 > 1.2.0-beta
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const partsA = a.split('.');
  const partsB = b.split('.');

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i];
    const y = partsB[i];
    if (x === undefined) return -1; // fewer fields sorts lower
    if (y === undefined) return 1;

    const numX = /^\d+$/.test(x);
    const numY = /^\d+$/.test(y);

    if (numX && numY) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (numX) {
      return -1; // numeric sorts lower than alphanumeric
    } else if (numY) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare two version strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b, or null if either is unparseable.
 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;

  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;

  const pre = comparePrerelease(va.prerelease, vb.prerelease);
  return pre === 0 ? 0 : pre < 0 ? -1 : 1;
}

/**
 * Decide which badge a mod's section should show.
 *
 * Returns one of:
 *   { status: 'not-installed' }          — nothing on disk, so nothing to update
 *   { status: 'unknown' }                — we lack a Nexus version to compare against
 *   { status: 'up-to-date' }             — installed version matches latest
 *   { status: 'update-available', from, to }
 *   { status: 'ahead' }                  — installed is NEWER than Nexus (beta/manual build)
 *   { status: 'unparseable', installed, latest }
 */
function getUpdateStatus(mod) {
  const installed = mod.version_installed;
  const latest = mod.version_latest;

  if (!mod.currently_installed || !installed) return { status: 'not-installed' };
  if (!latest) return { status: 'unknown' };

  const cmp = compareVersions(installed, latest);

  // One of the two didn't parse. Fall back to a plain string comparison so we
  // can still say "these differ" without claiming which is newer.
  if (cmp === null) {
    return installed.trim() === latest.trim()
      ? { status: 'up-to-date' }
      : { status: 'unparseable', installed, latest };
  }

  if (cmp < 0) return { status: 'update-available', from: installed, to: latest };
  if (cmp > 0) return { status: 'ahead' };
  return { status: 'up-to-date' };
}

/** Presentation layer: label, colour and whether the badge shows at all. */
const BADGE_STYLES = {
  'not-installed':    { show: false },
  'unknown':          { show: false },
  'up-to-date':       { show: true,  label: 'Up to date',       color: '#4caf50' },
  'update-available': { show: true,  label: 'Update available', color: '#ff8a4c' },
  'ahead':            { show: true,  label: 'Ahead of Nexus',   color: '#8a8a8a' },
  'unparseable':      { show: true,  label: 'Version differs',  color: '#8a8a8a' },
};

/** Convenience: everything the UI needs to draw the badge, in one object. */
function getUpdateBadge(mod) {
  const result = getUpdateStatus(mod);
  const style = BADGE_STYLES[result.status];

  let detail = null;
  if (result.status === 'update-available') detail = `${result.from} → ${result.to}`;
  else if (result.status === 'unparseable') detail = `${result.installed} / ${result.latest}`;

  return { ...result, ...style, detail };
}

module.exports = {
  parseVersion,
  compareVersions,
  getUpdateStatus,
  getUpdateBadge,
};
