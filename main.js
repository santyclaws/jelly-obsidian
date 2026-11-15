/*
 * Jelly for Obsidian — plain JavaScript, no build step. Install: copy manifest.json and main.js into
 * <vault>/.obsidian/plugins/jelly-sync/, then Settings → Community plugins → enable "Jelly".
 *
 * What it does, every minute and when you edit a note that matters:
 *   1. Sends Jelly a FILTERED view of your recent daily notes (a week back, two weeks ahead), your project notes and
 *      any other notes you pick: their headings and checkboxes, plus only the front matter, lines and sections you
 *      chose. Your journal prose never leaves Obsidian. ("Jelly: show what is sent" shows it for the open note.)
 *   2. Applies what Jelly changed — a ticked task, a step added to a project, a value you edited in Jelly, a meal or dose
 *      you logged in Jelly (daily notes, under your meals/meds headings; 0.3.4) — to the
 *      exact line in your real note, keeping everything else. If a change can't be placed exactly, it waits.
 * Works with Obsidian's Daily notes or the Periodic Notes plugin, any folder and date format, any list style.
 */
'use strict';
const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, TFile, Modal, normalizePath, requestUrl } = obsidian;

const DEFAULTS = {
  server: '', token: '', sendDaily: true, sendInsights: null, sendProjects: true, // sendInsights null = as the server says (on only where there's an Insights) leaveOut: '', dailyFolder: '', dailyFormat: '',
  projectsFolder: 'Projects', todoHeading: '', also: '',
  frontmatter: 'none', frontmatterKeys: '', linePrefixes: '', sections: '', every: 60,
};
const TASK = /^\s*(?:[-*+]|\d{1,3}[.)]) \[[ xX]\] /;
const list = v => String(v || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const SECRET = /token|secret|password|passwd|api[_-]?key|private[_-]?key|credential/i;

// ------------------------------------------------------------------ what is sent: a filtered view of a note
/**
 * The lines of `text` Jelly gets, and where each came from (map[i] = line number in the real note). Always: headings,
 * checkboxes and "---" rules (they shape sections). Front matter: none / all / only some keys. Plus lines starting with
 * one of `prefixes`, and every line under a heading named in `sections`. Nothing else — not the prose around them.
 */
function view(text, o = {}) {
  const L = String(text).split(/\r?\n/), lines = [], map = [];
  const keep = i => { lines.push(L[i]); map.push(i); };
  const keys = list(o.frontmatterKeys).map(k => k.toLowerCase()), prefixes = list(o.linePrefixes).map(p => p.toLowerCase()), sections = list(o.sections).map(s => s.toLowerCase().replace(/^#+\s*/, ''));
  let i = 0;
  if (L[0] === '---') {
    const end = L.indexOf('---', 1);
    if (end > 0) {
      if (o.frontmatter === 'all' || o.frontmatter === 'scalar' || (o.frontmatter === 'keys' && keys.length)) {
        keep(0);
        for (let k = 1; k < end; k++) {
          const m = /^([^:#\s][^:]*):(.*)$/.exec(L[k]), key = m ? m[1].trim().toLowerCase() : '', val = m ? m[2].trim() : '';
          const scalar = m && !SECRET.test(key) && !/^[[{|>]/.test(val) && !(val === '' && /^\s+\S/.test(L[k + 1] || '')); // one-line values: no lists, maps or blocks; nothing that reads like a secret
          if (o.frontmatter === 'all' || (o.frontmatter === 'scalar' && scalar) || (m && keys.includes(key))) keep(k);
        }
        keep(end);
      }
      i = end + 1;
    }
  }
  let section = null;
  for (; i < L.length; i++) {
    const l = L[i], h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) { section = h[1].toLowerCase(); keep(i); continue; }
    if (/^---\s*$/.test(l)) { section = null; keep(i); continue; }
    if (TASK.test(l)) { keep(i); continue; }
    if (section && sections.includes(section) && l.trim()) { keep(i); continue; }
    const t = l.trimStart().toLowerCase();
    if (t && prefixes.some(p => t.startsWith(p))) keep(i);
  }
  return { lines, map };
}

// ------------------------------------------------------------------ putting Jelly's change back into the real note
/** Line diff (LCS): [{ type: 'eq'|'del'|'ins', a?: line, b?: line }] turning `a` into `b`. */
function diff(a, b) {
  const n = a.length, m = b.length, D = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) D[i][j] = a[i] === b[j] ? D[i + 1][j + 1] + 1 : Math.max(D[i + 1][j], D[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { out.push({ type: 'eq', a: a[i] }); i++; j++; } else if (D[i + 1][j] >= D[i][j + 1]) out.push({ type: 'del', a: a[i++] }); else out.push({ type: 'ins', b: b[j++] }); }
  while (i < n) out.push({ type: 'del', a: a[i++] });
  while (j < m) out.push({ type: 'ins', b: b[j++] });
  return out;
}
/** Find `lines` as a run in `hay`, nearest to `near`; -1 if absent. */
function find(hay, lines, near) {
  let best = -1;
  for (let i = 0; i + lines.length <= hay.length; i++) {
    if (lines.every((l, k) => hay[i + k] === l) && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i;
  }
  return best;
}
/**
 * Apply Jelly's edit (base -> jelly) to `local` by matching line content (used when the note changed since it was
 * sent). Returns the merged text, or null when a change can't be placed exactly (nothing is written; tried later).
 */
function merge(base, jelly, local) {
  if (base === null || base === undefined) return local === null || local === undefined ? jelly : null; // Jelly made a new note
  if (local === base) return jelly;
  const eol = local.includes('\r\n') ? '\r\n' : '\n';
  const b = base.split(/\r?\n/), j = jelly.split(/\r?\n/), out = local.split(/\r?\n/);
  if (b.length > 3000 || j.length > 3000) return null;
  const ops = diff(b, j), hunks = [];
  let pos = 0, before = null;
  for (let k = 0; k < ops.length;) {
    if (ops[k].type === 'eq') { before = ops[k].a; pos++; k++; continue; }
    const h = { at: pos, del: [], ins: [], before };
    while (k < ops.length && ops[k].type !== 'eq') { if (ops[k].type === 'del') { h.del.push(ops[k].a); pos++; } else h.ins.push(ops[k].b); k++; }
    h.after = k < ops.length ? ops[k].a : null;
    hunks.push(h);
  }
  let shift = 0;
  for (const h of hunks) {
    const near = h.at + shift;
    if (h.del.length) {
      const i = find(out, h.del, near); if (i < 0) return null;
      out.splice(i, h.del.length, ...h.ins); shift += h.ins.length - h.del.length;
    } else if (h.before !== null) {
      const i = find(out, [h.before], near - 1); if (i < 0) return null;
      out.splice(i + 1, 0, ...h.ins); shift += h.ins.length;
    } else if (h.after !== null) {
      const i = find(out, [h.after], near); if (i < 0) return null;
      out.splice(i, 0, ...h.ins); shift += h.ins.length;
    } else { out.splice(0, 0, ...h.ins); shift += h.ins.length; }
  }
  return out.join(eol);
}
/**
 * Jelly's edit to a note's filtered view (base -> jelly), applied to the real note `local`. When the note's view is
 * still exactly what was sent, every change goes to the precise line it came from (the view's map), prose untouched;
 * otherwise the content-matching merge above. null = can't place it exactly now.
 */
function apply(base, jelly, local, o) {
  if (base === null || base === undefined || local === null || local === undefined) return merge(base, jelly, local);
  const eol = local.includes('\r\n') ? '\r\n' : '\n', L = local.split(/\r?\n/), v = view(local, o);
  if (v.lines.join('\n') !== base.split(/\r?\n/).join('\n')) return merge(base, jelly, local);
  const del = new Set(), after = new Map(); let vi = 0, last = -1;
  const put = (at, line) => { if (!after.has(at)) after.set(at, []); after.get(at).push(line); };
  for (const op of diff(v.lines, jelly.split(/\r?\n/))) {
    if (op.type === 'eq') { last = v.map[vi++]; }
    else if (op.type === 'del') { last = v.map[vi++]; del.add(last); }
    else put(last, op.b);
  }
  const out = [...(after.get(-1) || [])];
  L.forEach((l, i) => { if (!del.has(i)) out.push(l); out.push(...(after.get(i) || [])); });
  return out.join(eol);
}

// ------------------------------------------------------------------ what Jelly may write (defence against a bad server)
// Jelly only ever ticks a to-do, adds a "- [ ] step" to a project, logs a meal or dose in a daily note (0.3.4: see
// mealFill / noteLine below), fills an empty mood: / energy: line with 1–10 (0.3.5: frontFill), sets a person's name/birthday/last contact and makes a
// new project note (server/lib/vault.js). Anything else in a change is left out, so a hijacked or spoofed server can't
// put templates, scripts or links into a vault (Templater runs <% %>, Dataview runs dataviewjs and `$=`; a remote image
// ![](https://…) would tell a server when the note is opened).
const FORBIDDEN = /```|~~~|<%|<\/?[a-z!]|dataviewjs|`\s*\$=|obsidian:\/\/|javascript:|vbscript:|\]\(\s*(?!https?:)[a-z][\w+.-]*:|!\[[^\]]*\]\(/i;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/; // control and bidi-override characters
const unsafe = l => l.length > 500 || FORBIDDEN.test(l) || CONTROL.test(l);
const TASK_PARTS = /^(\s*(?:[-*+]|\d{1,3}[.)]) )\[( |x|X)\] (.*)$/;
const STAMP = /\s*✅\s*\d{4}-\d{2}-\d{2}/g;
const KV = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/;
const PERSON_KEYS = ['name', 'birthday', 'last_contact']; // vault.js setPersonField / fillPersonField
const NEW_NOTE_KEYS = ['title', 'type', 'status', 'created', 'due']; // vault.js writeProject's front matter
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
// 0.3.4 (feedback #76): in a DAILY note Jelly may also log a meal or a dose you entered in Jelly — fill an empty
// "Breakfast:" line, or add "Lunch: soup at 13:00" under a meals heading, or "- Took 1 vitamin D at 08:00" under a meds
// heading. Plain words only: the usual unsafe() filter, no [[links]], at most 300 characters.
const MEAL_KEY = /^(breakfast|lunch|dinner|snacks?|supper)$/i;
const MEALS_HEADING = /^(meals?|food)$/i, MEDS_HEADING = /^(meds?|medications?|supplements?)$/i;
const noteWords = l => l.length <= 300 && !unsafe(l) && !l.includes('[[');
/** An empty "Breakfast:" line, now "Breakfast: eggs at 8:00" (daily notes; the line had nothing after the colon). */
function mealFill(a, b, ctx) {
  if (!ctx.daily) return false;
  const x = KV.exec(a), y = KV.exec(b);
  return !!(x && y && x[1] === y[1] && MEAL_KEY.test(x[1]) && !x[2].trim() && y[2].trim() && noteWords(b));
}
/** 0.3.5 (feedback #177): mood or energy logged in Jelly — an EMPTY "mood:" / "energy:" line in a daily note filled
 *  with a number from 1 to 10 (one decimal at most). Never a line that already has a value, never another key. */
const FRONT_KEY = /^(mood|energy)$/i, ONE_TO_TEN = /^(?:10|[1-9])(?:\.\d)?$/;
function frontFill(a, b, ctx) {
  if (!ctx.daily) return false;
  const x = KV.exec(a), y = KV.exec(b);
  return !!(x && y && x[1] === y[1] && FRONT_KEY.test(x[1]) && !x[2].trim() && ONE_TO_TEN.test(y[2].trim()) && !unsafe(b));
}
/** The heading of the section a line lands in (nearest above; "---" ends a section), lower-cased, or null. */
function sectionOf(above) {
  for (let i = above.length - 1; i >= 0; i--) { const h = HEADING.exec(above[i]); if (h) return h[1].toLowerCase(); if (/^---\s*$/.test(above[i])) return null; }
  return null;
}
/** A meal or dose line Jelly may add to a daily note: under a meals or meds heading only. */
function noteLine(line, above, ctx) {
  if (!ctx.daily || !noteWords(line)) return false;
  const sec = sectionOf(above); if (!sec) return false;
  const kv = KV.exec(line);
  if (MEALS_HEADING.test(sec)) return !!(kv && MEAL_KEY.test(kv[1]) && kv[2].trim());
  if (MEDS_HEADING.test(sec)) return /^- (?!\[)\S/.test(line);
  return false;
}
/** The same to-do, only ticked or unticked (the "✅ date" stamp may come or go); the person's own text is unchanged. */
function tickPair(a, b) {
  const x = TASK_PARTS.exec(a), y = TASK_PARTS.exec(b);
  return !!(x && y && x[1] === y[1] && x[3].replace(STAMP, '').trimEnd() === y[3].replace(STAMP, '').trimEnd());
}
/** One of a person note's values changed (same key), or only trailing spaces went. */
function valuePair(a, b) {
  if (a.trimEnd() === b.trimEnd()) return true;
  const x = KV.exec(a), y = KV.exec(b);
  return !!(x && y && x[1] === y[1] && PERSON_KEYS.includes(x[1]) && !unsafe(b));
}
/** May Jelly add this line here? A blank, a "## Tasks" heading, a person value, or a new "- [ ] step" in a to-do section. */
function insertable(line, above, ctx) {
  if (!line.trim() || /^## Tasks\s*$/.test(line)) return true;
  if (unsafe(line)) return false;
  if (noteLine(line, above, ctx)) return true;
  const kv = KV.exec(line); if (kv && PERSON_KEYS.includes(kv[1])) return true;
  if (!/^- \[ \] \S/.test(line)) return false;
  let heading = null; // the section it lands in: nearest heading above ("---" ends a section, as in view())
  for (let i = above.length - 1; i >= 0; i--) { const h = HEADING.exec(above[i]); if (h) { heading = h[1].toLowerCase(); break; } if (/^---\s*$/.test(above[i])) break; }
  const todo = String(ctx.todo || '').toLowerCase().replace(/^#+\s*/, '').trim();
  return heading === 'tasks' || (!!todo && heading === todo) || (!todo && !ctx.project);
}
/**
 * Jelly's edit to a note it already has (base -> jelly), cut down to what Jelly may do: ticks, person values, new to-do
 * lines. Jelly never removes a line, so a removed one stays. { text, dropped } — text null if it's too big to check.
 */
function vet(base, jelly, ctx = {}) {
  const b = String(base).split(/\r?\n/), j = String(jelly).split(/\r?\n/), out = []; let dropped = 0;
  if (b.length > 3000 || j.length > 3000) return { text: null, dropped: 1 };
  const ops = diff(b, j);
  for (let k = 0; k < ops.length;) {
    if (ops[k].type === 'eq') { out.push(ops[k++].a); continue; }
    const hunk = []; while (k < ops.length && ops[k].type !== 'eq') hunk.push(ops[k++]);
    const pair = new Map(), used = new Set(); // del index -> the ins that changes it in place; ins indexes taken
    hunk.forEach((d, di) => {
      if (d.type !== 'del') return;
      const ii = hunk.findIndex((x, xi) => x.type === 'ins' && !used.has(xi) && (tickPair(d.a, x.b) || valuePair(d.a, x.b) || mealFill(d.a, x.b, ctx) || frontFill(d.a, x.b, ctx)));
      if (ii >= 0) { used.add(ii); pair.set(di, ii); }
    });
    hunk.forEach((x, xi) => {
      // a changed line keeps its place: its new text goes where the old one was
      if (x.type === 'del') { if (pair.has(xi)) out.push(hunk[pair.get(xi)].b); else { out.push(x.a); dropped++; } return; }
      if (used.has(xi)) return;
      if (insertable(x.b, out, ctx)) out.push(x.b); else dropped++;
    });
  }
  return { text: out.join('\n'), dropped };
}
/** A note Jelly made (a new project): only in the projects folder; known front matter keys and safe lines only. */
function vetNew(jelly, ctx = {}) {
  if (!ctx.project) return { text: null, dropped: 1 };
  const L = String(jelly).split(/\r?\n/), out = []; let dropped = 0;
  if (L.length > 3000) return { text: null, dropped: 1 };
  const end = L[0] === '---' ? L.indexOf('---', 1) : -1;
  L.forEach((l, i) => {
    const front = end > 0 && i > 0 && i < end, kv = front && KV.exec(l);
    if (front ? (kv && NEW_NOTE_KEYS.includes(kv[1]) && !unsafe(l)) : !unsafe(l)) out.push(l); else dropped++;
  });
  return { text: out.join('\n'), dropped };
}

// ------------------------------------------------------------------ the Jelly address: https, or plain http at home only
/** A loopback or home-network host: 127/8, ::1, localhost, *.local, 10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale), fc00::/7, fe80::/10. */
function localHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h); if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
/** Why this address can't be used ('' = fine). Plain http on the internet would show the token and the notes to anyone on the way. */
function addressProblem(server) {
  let u; try { u = new URL(String(server || '').trim()); } catch (_) { return 'The Jelly address should look like https://jelly.example.com.'; }
  if (u.username || u.password) return 'Leave any user name and password out of the Jelly address.';
  if (u.protocol === 'https:' || (u.protocol === 'http:' && localHost(u.hostname))) return '';
  return 'The Jelly address must start with https://. Plain http:// only works for an address on your home network (like 192.168.x.x or localhost).';
}

// ------------------------------------------------------------------ the plugin
class JellyPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.sent = this.settings.sent || {}; // path -> hash of the view last sent
    this.addSettingTab(new JellySettings(this.app, this));
    this.addCommand({ id: 'sync-now', name: 'Sync with Jelly now', callback: () => this.sync(true) });
    this.addCommand({ id: 'show-sent', name: 'Show what is sent to Jelly for this note', callback: () => this.showSent() });
    this.addRibbonIcon('refresh-cw', 'Sync with Jelly', () => this.sync(true));
    this.registerInterval(window.setInterval(() => this.sync(false), Math.max(30, +this.settings.every || 60) * 1000));
    this.registerEvent(this.app.vault.on('modify', f => { if (this.wanted(f.path)) { clearTimeout(this.soon); this.soon = setTimeout(() => this.sync(false), 5000); } }));
    this.app.workspace.onLayoutReady(() => this.sync(false));
  }
  async save() { this.settings.sent = this.sent; await this.saveData(this.settings); }
  /**
   * The filter for one note. Daily notes, when "For Insights" is on (the default), also send what Insights reads:
   * their front matter (mood, energy, metrics) and the lines under a meds / meals heading, plus "Breakfast: …" and
   * "Took …" lines (12 Nov: on the server, meds, meals and mood had stopped arriving). Never the diary prose.
   */
  opts(p) {
    const s = this.settings;
    if (!p || !this.insightsOn() || !this.isDaily(p)) return s;
    const join = (a, b) => [...new Set([...list(a), ...list(b)])].join(', ');
    return { ...s, frontmatter: s.frontmatter === 'all' ? 'all' : 'scalar', sections: join(s.sections, 'meds, med, medication, medications, medication log, meals, food'),
      linePrefixes: join(s.linePrefixes, 'breakfast:, lunch:, dinner:, snacks:, snack:, took , - took , * took ') };
  }
  /** "For Insights": what you chose, else what the server says (on only for the account Insights is for). */
  insightsOn() { return this.settings.sendInsights === true || (this.settings.sendInsights == null && this.serverInsights === true); }
  async askServer() { try { const me = await this.call('GET', '/me'); this.serverInsights = !!(me && me.modules && me.modules.insights); } catch (_) { /* unknown: off */ } }
  /**
   * Jelly → Settings → Obsidian (0.3.2): whether to sync at all, which kinds of notes, and the folders when they were
   * set there. Asked before each sync; an older Jelly without it leaves everything to this plugin's own settings.
   */
  async askConfig() { try { const c = await this.call('GET', '/obsidian/config'); this.jelly = c && typeof c === 'object' ? c : null; } catch (e) { if (/disconnected/i.test(e.message)) throw e; this.jelly = null; } }
  isDaily(p) { const { folder, projects } = this.layout(); return !p.startsWith(projects + '/') && (folder ? p.startsWith(folder + '/') : Object.values(this.dailyMap()).includes(p)); }

  /** Daily notes: the Periodic Notes plugin if it's on, else Obsidian's Daily notes, unless overridden here. */
  layout() {
    const pn = this.app.plugins?.getPlugin?.('periodic-notes')?.settings?.daily;
    const dn = pn && pn.enabled !== false && (pn.folder !== undefined || pn.format) ? pn : (this.app.internalPlugins?.getPluginById?.('daily-notes')?.instance?.options || {});
    const j = this.jelly && this.jelly.layout; // set in Jelly: those folders win
    const folder = (j ? j.daily_folder : this.settings.dailyFolder || dn.folder || '').replace(/^\/+|\/+$/g, '');
    const format = (j && j.daily_pattern) || this.settings.dailyFormat || dn.format || 'YYYY-MM-DD';
    return { folder, format, projects: ((j && j.projects_folder) || this.settings.projectsFolder || 'Projects').replace(/^\/+|\/+$/g, '') };
  }
  /** Each day of the window -> the path of its note (whether or not it exists yet), with your own date format. */
  dailyMap() {
    const { folder, format } = this.layout(), out = {};
    for (let i = -7; i <= 14; i++) { const d = window.moment().add(i, 'days'); out[d.format('YYYY-MM-DD')] = normalizePath(`${folder ? folder + '/' : ''}${d.format(format)}.md`); }
    return out;
  }
  leftOut(p) { return list(this.settings.leaveOut).map(x => x.replace(/^\/+|\/+$/g, '')).some(x => p === x || p === `${x}.md` || p.startsWith(`${x}/`)); }
  alsoSent(p) { return list(this.settings.also).map(x => x.replace(/^\/+|\/+$/g, '')).some(x => p === x || p === `${x}.md` || p.startsWith(`${x}/`)); }
  sendsDaily() { return this.settings.sendDaily !== false && !(this.jelly && this.jelly.daily === false); }
  sendsProjects() { return this.settings.sendProjects !== false && !(this.jelly && this.jelly.projects === false); }
  todoHeading() { return this.jelly && this.jelly.layout ? this.jelly.layout.todo_heading || '' : this.settings.todoHeading || ''; }
  wanted(p) {
    if (!p.endsWith('.md') || this.leftOut(p)) return false;
    const { projects } = this.layout();
    return (this.sendsProjects() && p.startsWith(projects + '/')) || (this.sendsDaily() && Object.values(this.dailyMap()).includes(p)) || this.alsoSent(p);
  }

  async call(method, path, body) {
    const s = this.settings;
    if (!s.server || !s.token) throw new Error('Set your Jelly address and token in the plugin settings.');
    const bad = addressProblem(s.server); if (bad) throw Object.assign(new Error(bad), { address: true }); // before the token goes anywhere
    const r = await requestUrl({ url: s.server.replace(/\/$/, '') + '/api' + path, method, headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json', 'x-actor': 'obsidian', 'x-jelly-client': 'obsidian', 'x-jelly-plugin': String((this.manifest && this.manifest.version) || '') }, body: body ? JSON.stringify(body) : undefined, throw: false });
    if (r.status >= 400) throw new Error((r.json && r.json.error) || `Jelly answered ${r.status}`);
    return r.json;
  }

  async showSent() {
    const f = this.app.workspace.getActiveFile();
    if (!f) return new Notice('Open a note first.');
    const sent = this.wanted(f.path), v = view(await this.app.vault.cachedRead(f), this.opts(f.path)).lines.join('\n');
    const m = new Modal(this.app);
    m.titleEl.setText(sent ? `Sent to Jelly: ${f.basename}` : `${f.basename} is not sent to Jelly`);
    if (sent) m.contentEl.createEl('pre', { text: v || '(nothing: no headings, checkboxes or chosen lines)' }).style.whiteSpace = 'pre-wrap';
    else m.contentEl.createEl('p', { text: 'Only your recent daily notes, your projects folder and the notes you added under "Also send" are sent, filtered.' });
    m.open();
  }

  async sync(loud) {
    if (this.busy) return; this.busy = true;
    try {
      if (this.settings.sendInsights == null && this.serverInsights === undefined) await this.askServer();
      await this.askConfig();
      if (this.jelly && this.jelly.sync === false) throw new Error('Obsidian is disconnected in Jelly. To use it again: Jelly → Settings → Obsidian → Reconnect.');
      const { folder, format, projects } = this.layout(), daily = this.dailyMap();
      const files = [], seen = new Set();
      const consider = async f => {
        if (!(f instanceof TFile) || !this.wanted(f.path)) return;
        seen.add(f.path);
        const v = view(await this.app.vault.cachedRead(f), this.opts(f.path)).lines.join('\n'), h = hash(v);
        if (loud || this.sent[f.path] !== h) files.push({ path: f.path, content: v, h });
      };
      for (const p of Object.values(daily)) await consider(this.app.vault.getAbstractFileByPath(p));
      for (const f of this.app.vault.getMarkdownFiles()) if (f.path.startsWith(projects + '/') || this.alsoSent(f.path)) await consider(f);
      // sent before but gone or left out now: Jelly's copy drops them too (daily notes that just left the window stay)
      const deleted = Object.keys(this.sent).filter(p => !seen.has(p) && (!this.app.vault.getAbstractFileByPath(p) || !this.wantedEver(p)));
      const layout = { daily_folder: folder, daily_pattern: format, projects_folder: projects, todo_heading: this.todoHeading() };
      let changes;
      if (files.length || deleted.length) {
        let k = 0;
        do { // batches under ~700 KB; the deletions go with the last one
          const batch = []; let size = 0;
          while (k < files.length && (!batch.length || size + files[k].content.length < 700000)) { size += files[k].content.length; batch.push(files[k++]); }
          const r = await this.call('POST', '/obsidian/push', { files: batch.map(f => ({ path: f.path, content: f.content })), deleted: k >= files.length ? deleted : [], layout, daily_paths: daily });
          for (const f of batch) this.sent[f.path] = f.h;
          changes = r.changes || [];
        } while (k < files.length);
        for (const d of deleted) delete this.sent[d];
      } else changes = (await this.call('GET', '/obsidian/changes')).changes || [];
      let applied = 0, waiting = 0, refused = 0;
      for (const c of changes) {
        // only ever a plain note inside the vault, in what this plugin sends (defence in depth: the server checks too)
        const p = String(c.path || '');
        if (!p.endsWith('.md') || p.startsWith('/') || p.includes('\\') || p.split('/').some(seg => !seg || seg === '..' || seg.startsWith('.')) || !this.wantedEver(p) || typeof c.content !== 'string') continue;
        const f = this.app.vault.getAbstractFileByPath(p), local = f instanceof TFile ? await this.app.vault.read(f) : null;
        // only what Jelly does (ticks, new steps, person values; new notes only in the projects folder) — never a rewrite
        const ctx = { project: p.startsWith(projects + '/'), daily: Object.values(daily).includes(p), todo: this.todoHeading() }, made = c.base === null || c.base === undefined;
        if (!made && local === null) continue; // gone here: it leaves Jelly with the next push, never re-made from Jelly's copy
        const vetted = made ? (local === null ? vetNew(c.content, ctx) : { text: c.content, dropped: 0 }) : vet(c.base, c.content, ctx); // made + already here: merge() waits
        refused += vetted.dropped;
        if (vetted.text === null) continue;
        const o = this.opts(p), merged = apply(c.base, vetted.text, local, o);
        if (merged === null) { waiting++; continue; }
        if (merged !== local) {
          if (f instanceof TFile) await this.app.vault.modify(f, merged);
          else { const dir = p.split('/').slice(0, -1).join('/'); if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {}); await this.app.vault.create(p, merged); }
          applied++;
        }
        const v = view(merged, o).lines.join('\n'); // Jelly gets the filtered view back, never the whole note
        await this.call('POST', '/obsidian/ack', { path: p, content: v });
        this.sent[p] = hash(v);
      }
      await this.save();
      const left = refused ? `${refused} line${refused === 1 ? '' : 's'} from Jelly left out (only ticks and new to-dos are written into your notes)` : '';
      if (loud) new Notice(`Jelly: ${files.length} note${files.length === 1 ? '' : 's'} sent${applied ? `, ${applied} updated from Jelly` : ''}${waiting ? `, ${waiting} waiting (edited here at the same time — will retry)` : ''}${left ? `, ${left}` : ''}.`);
      else {
        if (waiting && !this.warned) { this.warned = true; new Notice(`Jelly has ${waiting} change(s) it couldn't place exactly — they'll be retried.`); }
        if (left && !this.warnedLeft) { this.warnedLeft = true; new Notice(`Jelly: ${left}.`); }
      }
    } catch (e) { if (loud || (e.address && !this.warnedAddress)) { if (e.address) this.warnedAddress = true; new Notice(`Jelly: ${e.message}`); } }
    finally { this.busy = false; }
  }
  /** Could this path be one of ours at all (daily notes outside the current window included)? */
  wantedEver(p) {
    if (!p.endsWith('.md') || this.leftOut(p)) return false;
    const { folder, projects } = this.layout();
    return (this.sendsProjects() && p.startsWith(projects + '/')) || (this.sendsDaily() && (!folder || p.startsWith(folder + '/'))) || this.alsoSent(p);
  }
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ':' + s.length; }

class JellySettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, s = this.plugin.settings, save = async () => { await this.plugin.save(); };
    const text = (name, desc, key, ph, area) => new Setting(el).setName(name).setDesc(desc)[area ? 'addTextArea' : 'addText'](t => t.setPlaceholder(ph || '').setValue(s[key] || '').onChange(async v => { s[key] = v.trim(); await save(); }));
    el.empty();
    el.createEl('p', { text: 'Jelly gets the headings and checkboxes of the notes below, plus only what you choose here — never the rest of your writing. Command "Show what is sent to Jelly for this note" shows exactly what leaves Obsidian.' });
    const addr = new Setting(el).setName('Jelly address'), hint = () => addr.setDesc((s.server && addressProblem(s.server)) || 'e.g. https://jelly.example.com (plain http:// only for an address on your home network)');
    hint(); addr.addText(t => t.setValue(s.server).onChange(async v => { s.server = v.trim(); hint(); await save(); }));
    new Setting(el).setName('Token').setDesc('Jelly → Settings → Obsidian → Make a token.').addText(t => { t.inputEl.type = 'password'; t.setValue(s.token).onChange(async v => { s.token = v.trim(); await save(); }); });

    el.createEl('h3', { text: 'Which notes' });
    new Setting(el).setName('Daily notes').setDesc('To-dos in your daily notes, a week back and two weeks ahead.').addToggle(t => t.setValue(s.sendDaily !== false).onChange(async v => { s.sendDaily = v; await save(); }));
    new Setting(el).setName('For Insights: mood, meals and medicines').setDesc('Also sends your daily notes\u2019 front matter (one-line values like mood and energy \u2014 never anything named like a password, token or key), the lines under a \u201cmeds\u201d or \u201cmeals\u201d heading, and \u201cBreakfast: \u2026\u201d / \u201cTook \u2026\u201d lines, so Insights can show them. On by itself only if your Jelly has Insights. Never the rest of what you write.')
      .addToggle(t => t.setValue(this.plugin.insightsOn()).onChange(async v => { s.sendInsights = v; this.plugin.sent = {}; await save(); }));
    const { folder, format } = this.plugin.layout();
    new Setting(el).setName('Where your daily notes are').setDesc(this.plugin.jelly && this.plugin.jelly.layout ? `Set in Jelly (Settings → Obsidian): ${folder || '(vault root)'} / ${format}. Change them there.` : `From Periodic Notes or Obsidian's Daily notes settings: ${folder || '(vault root)'} / ${format}. Fill these only to override.`)
      .addText(t => t.setPlaceholder('folder').setValue(s.dailyFolder).onChange(async v => { s.dailyFolder = v.trim(); await save(); }))
      .addText(t => t.setPlaceholder('format, e.g. YYYY-MM-DD').setValue(s.dailyFormat).onChange(async v => { s.dailyFormat = v.trim(); await save(); }));
    text('To-dos under a heading', 'Only checkboxes under "## <this>" in a daily note count. Empty = every checkbox in the note.', 'todoHeading', 'e.g. to do');
    new Setting(el).setName('Project notes').setDesc('One note per project; its checklist under "## Tasks". Jelly adds new projects here.').addToggle(t => t.setValue(s.sendProjects !== false).onChange(async v => { s.sendProjects = v; await save(); }));
    text('Projects folder', '', 'projectsFolder', 'Projects');
    text('Also send', 'Other notes or folders, one per line — filtered the same way (e.g. a tasks note, a routines note, a people folder).', 'also', 'Home/Tasks.md', true);
    text('Never send', 'Folders or notes to leave out, one per line. Anything already sent is removed from Jelly.', 'leaveOut', 'Projects/Private', true);

    el.createEl('h3', { text: 'What else from those notes' });
    new Setting(el).setName('Front matter').setDesc('The properties at the top of a note (needed if Jelly or Insights reads values like mood from them).')
      .addDropdown(d => d.addOptions({ none: 'none', keys: 'only these keys', all: 'all of it' }).setValue(s.frontmatter || 'none').onChange(async v => { s.frontmatter = v; await save(); }))
      .addText(t => t.setPlaceholder('mood, energy').setValue(s.frontmatterKeys).onChange(async v => { s.frontmatterKeys = v.trim(); await save(); }));
    text('Lines starting with', 'One per line, e.g. "Breakfast:" or "Took". Only those lines are sent.', 'linePrefixes', 'Breakfast:\nLunch:', true);
    text('Whole sections', 'Headings whose contents are sent in full, one per line (e.g. "Meals"). Leave empty to send none.', 'sections', 'Meals', true);
    new Setting(el).setName('Sync now').addButton(b => b.setButtonText('Sync').setCta().onClick(() => this.plugin.sync(true)));
  }
}

module.exports = JellyPlugin;
module.exports.merge = merge; // for tests (server/test/obsidian.test.js)
module.exports.view = view;
module.exports.apply = apply;
Object.assign(module.exports, { vet, vetNew, unsafe, addressProblem, localHost, mealFill, noteLine, frontFill }); // for tests (server/test/audit-ui-plugin.test.js)
