# Stardew Mod Tracker

A local app for keeping track of Stardew Valley mods: ones you're interested in,
ones you have installed, and ones you tried and removed. Records survive deleting
the files.

## Setup

1. Put every file in one folder, keeping `public/` as a subfolder:

   ```
   stardew-mod-tracker/
     package.json
     schema.sql
     db.js
     nexus.js
     version.js
     server.js
     public/
       index.html
       app.js
       style.css
   ```

2. Install dependencies (needs Node 18 or newer):

   ```bash
   npm install
   ```

3. Start it:

   ```bash
   npm start
   ```

4. Open <http://localhost:3000>.

5. On first run the Setup panel is showing. Paste your Nexus API key — you get one
   from your Nexus Mods account settings, under the API tab — and press Save.

## Using it

**Add a mod.** Paste a Nexus link into the Add box and press Enter. A bare mod id
works too. The app fetches the name, author, summary, category, thumbnail and
latest version, and caches all of it locally so it never has to ask again.

**Tags.** Type a name into the "add a tag" box on any card and press Enter. New
tags are created on the spot and become available to every other mod. Click tags
in the filter row to narrow the list — selecting several requires a mod to have
all of them.

**Search.** Matches names, authors, summaries, your notes, and tag names. Mods
whose name starts with what you typed sort first.

**Notes.** Type in the notes box on a card; it saves when you click away.

**Refresh.** Re-fetches one mod's details from Nexus, which is how the latest
version gets updated.

## The two checkboxes

- **Tried before** — turns on the first time the folder scanner finds the mod
  installed, and never turns off again.
- **In Mods folder** — reflects what the scanner found on its last run.

Both are off for a mod you've only added by link, which is correct: you haven't
installed it. They stay off until the folder scanner exists and runs.

## The update badge

When a mod is installed and the installed version is older than the version on
Nexus, the card shows an orange **Update available** badge with `old → new`.
Matching versions show a green **Up to date**. A mod that isn't installed shows
no badge, since there's nothing on disk to update.

Versions are compared as semantic versions, not as text, so 2.10.0 correctly
counts as newer than 2.9.0.

## Where your data lives

`~/.stardew-mod-tracker/mods.db` — a single SQLite file holding your mods, tags,
notes and settings, including the API key. It sits outside the project folder, so
moving or re-cloning the code doesn't touch it. Back up that one file and you've
backed up everything.

To put it somewhere else, set `SMT_DB_PATH` before starting:

```bash
SMT_DB_PATH=/path/to/mods.db npm start
```

## Not built yet

The folder scanner. It walks your Mods folder, reads each `manifest.json`,
matches mods by `UniqueID`, fills in the installed version and folder path, and
drives the two checkboxes. The database and the UI are already shaped for it —
the `mods_folder` setting in the Setup panel is where its path goes.
