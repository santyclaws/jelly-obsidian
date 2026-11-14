# Jelly for Obsidian

This plugin connects a person's Obsidian vault to their own Jelly. It is for people whose vault is not on the Jelly server, which means everyone except the owner (the owner's vault is read directly).

**What leaves your Obsidian is a filtered view, never whole notes:**

| Always sent | Sent only if you choose | Never sent |
|---|---|---|
| Headings, checkboxes (`- [ ]`, `* [ ]`, `1. [ ]` …) and `---` rules | Front matter (none / some keys / all) · lines starting with words you list (e.g. `Breakfast:`) · whole sections under headings you list | Everything else: your journal prose, other notes, attachments |

**Which notes:**
- daily notes from a week back to two weeks ahead;
- your projects folder;
- anything you add under **Also send**.

**Never send** excludes folders or notes, and anything excluded later is removed from Jelly.

**Seeing it for yourself:** the command **"Show what is sent to Jelly for this note"** shows exactly what leaves Obsidian.

**What comes back** (only these — anything else Jelly sends is left out, and a notice says so):
- ticks (`[x] … ✅ date`) on to-dos already in your note;
- new `- [ ] ` steps, under a project's `## Tasks` (or your to-do heading);
- new project notes, only inside your projects folder;
- a person's name, birthday or last contact, edited in Jelly (people notes you chose to send).

Each lands on its exact line in the real note, and the rest of your writing isn't touched. Jelly never removes or rewrites a line. If you've edited that same line at the same moment, the change waits and is tried again.

**Never written into your vault**, whatever the server says: code blocks (```` ``` ````, `~~~`), Templater (`<% %>`), `dataviewjs` or inline `$=` queries, HTML tags, `obsidian://` or `javascript:` links. So even a hijacked or spoofed server can't add something that runs in your Obsidian.

**The address must be `https://`.** Plain `http://` only works for an address on your home network (`192.168.x.x`, `10.x`, `172.16–31.x`, `100.64–127.x` (Tailscale), `localhost`, `*.local`): on the internet it would show your token and notes to anyone in between.

**Your own setup works:**
- **Daily notes:** Obsidian's Daily notes or the **Periodic Notes** plugin, with any folder and any date format. The plugin tells Jelly where each day's note is.
- **To-dos:** under one heading, or anywhere in the note.
- **Lists:** any list style.

## Install

1. In Jelly, go to Settings → Obsidian → **Make a token**.
2. In the vault, create the folder `.obsidian/plugins/jelly-sync/`.
3. Put `manifest.json` and `main.js` in it. Jelly ⚙ → Obsidian has download links for both.
4. In Obsidian, go to Settings → Community plugins and turn on **Jelly**.
5. In the plugin's settings, set your Jelly address (`https://…`) and the token.
6. Phones: if you use Obsidian Sync, turn on "Installed community plugins" in its settings so the plugin reaches them.

## Settings

- **Daily notes folder and format:** taken from Periodic Notes or Obsidian's Daily notes. Any format works, weekday names included.
- **To-dos under a heading:** for example `to do`, which counts only the checkboxes under `## to do`. Empty means every checkbox in the daily note counts.
- **Projects folder:** defaults to `Projects`.

## Phones and tablets without a file manager (BRAT)

The plugin is also released to the public repo `santyclaws/jelly-obsidian`, so it installs from inside Obsidian with BRAT (from Obsidian's plugin list), with no GitHub token. After a change here, publish it there too: copy `main.js`, `manifest.json` and this README, bump `version` in `manifest.json`, commit there with `git -c user.email=santyclaws@users.noreply.github.com` (never a personal address: that repo is public), push, then `gh release create <version> main.js manifest.json --repo santyclaws/jelly-obsidian`. BRAT updates the devices.

## Version

0.3.3 (2026-11-14): the token is made in Jelly → Settings → Obsidian (the wording pointed elsewhere).

0.3.2 (2026-11-13): sends `x-jelly-client: obsidian` (so Disconnect ends only the plugin's token); follows Jelly → Settings → Obsidian (`GET /api/obsidian/config`): stops when Obsidian is disconnected there, leaves out daily notes or project notes switched off there, and uses the folders and to-do heading when they were set there. manifest.json had been committed empty in 0.3.1; it is whole again.

0.3.1 (2026-11-12): "For Insights" — daily notes also send one-line front matter (never a key named like a password, token or key), the lines under a meds / meals heading and "Breakfast: …" / "Took …" lines. On by itself only where the server has Insights (/api/me modules.insights); a switch in the plugin's settings either way.

0.2.0 (2026-11-10): only ticks, new steps, new project notes and people values are written back; https only (plain http at home).

## Server side

`server/lib/obsidian-mirror.js` keeps each person's copy of their vault (`/api/obsidian/push`, `/changes`, `/ack`).

`server/test/obsidian.test.js` tests the merge and the round trip; `server/test/audit-ui-plugin.test.js` tests what the plugin refuses to write and that every change the server makes still lands.
