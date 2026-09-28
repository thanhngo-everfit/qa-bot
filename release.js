// ─────────────────────────────────────────────────────────────────────
// release.js — the Project Coordinator's release work, automated.
//
// Mirrors how the PCs work in #internal-release-process:
//   1. Draft the release announcement from Jira (fix version, date,
//      items = the cards' epics, PIC = assignees) in the team's format.
//   2. DM the draft to the approver with readiness + the decisions only a
//      person can make (mobile release notes, force/optional update).
//   3. "Approve & post" publishes it to the release channel.
//   4. Remind the approver if a draft is still pending the day before.
//   5. Daily readiness check in the announcement thread until release.
//
// Source of truth: UP fix versions (Core + Challenger — Challenger
// releases are UP versions named "… Challenger …").
// ─────────────────────────────────────────────────────────────────────
const axios = require('axios');
const lib = require('./lib');
const { JIRA_HOST, jiraAuth } = lib;

const RELEASE_CHANNEL   = process.env.RELEASE_CHANNEL   || 'C02K8962G9J';   // #internal-release-process
const RELEASE_APPROVERS = (process.env.RELEASE_APPROVERS || 'U0142GU335F,U0445EQS1ED').split(',').map(s => s.trim()).filter(Boolean);
const RELEASE_PROJECT   = process.env.RELEASE_PROJECT   || 'UP';
// Automatic review + reminders happen in the leads' channel, tagging them.
const RELEASE_REVIEW_CHANNEL = process.env.RELEASE_REVIEW_CHANNEL || 'C0BND0T6Y3C';   // #core-scrum-team
const RELEASE_NOTIFY = (process.env.RELEASE_NOTIFY || 'U0142GU335F,U0445EQS1ED').split(',').map(s => s.trim()).filter(Boolean);   // Thanh, Bao Ho
const notifyTags = () => RELEASE_NOTIFY.map(u => `<@${u}>`).join(' ');
const threadLink = (channel, ts, threadTs) =>
  `https://everfitt.slack.com/archives/${channel}/p${String(ts).replace('.', '')}${threadTs ? `?thread_ts=${threadTs}&cid=${channel}` : ''}`;
const LOOKAHEAD_WORKDAYS = parseInt(process.env.RELEASE_LOOKAHEAD_WORKDAYS || '2', 10);
const CC_GROUP = process.env.RELEASE_CC_GROUP || 'S0B57DFQUKU';   // cc'd on every Core release post

// Platform groups the PCs tag in the header (learned from the channel).
const FAMILY_GROUPS = {
  Web:            ['S014NEP6KEU', 'S0120RDU4D9'],
  API:            ['S01RGABFZMK', 'S0120RDU4D9'],
  iOS:            ['S013BQCBF4H'],
  Android:        ['S012XQ9L38D'],
  Academy:        ['S0ANY6Z1XM4'],
  'Internal API': ['S0ANY6Z1XM4'],
  CMS:            ['S08E0CUJA2D'],
  Challenger:     [],
};

const DONE_STATUSES = new Set(['qa success', 'done', 'released', 'closed', 'will not fix', 'ba success', 'qa completed']);
const NOT_A_RELEASE = /^(?:n\s*\/?\s*a|to be confirmed|will not release)\b|\(tbd\)|\btbd\b/i;   // placeholders, not releases
// A real release version is "<Platform> <number>" — e.g. iOS Coach 2.83.1,
// Web 4.37.1, Academy CMS 0.2.4, API Challenger 1.0.0. Two-part numbers
// (iOS Coach 2.83) are the team's normal minor format. Anything else —
// "Training - Mobile cards" — is a PC's draft placeholder.
const VALID_VERSION_RE = /^(?:(?:iOS|Android)\s+(?:Coach|Client)|Web|API|Internal API|Academy\s+(?:Web|CMS)|CMS|MP API|(?:Web|API|iOS|Android)\s+Challenger)\s+\d+(?:\.\d+){1,3}$/i;
const isRealVersionName = (name) => VALID_VERSION_RE.test((name || '').trim());

const headers = () => ({ Authorization: jiraAuth(), Accept: 'application/json' });
const vnNow   = () => new Date(Date.now() + 7 * 3600 * 1000);
const isoDay  = (d) => d.toISOString().substring(0, 10);
const prettyDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
// Slack link labels must escape & < > (a version like "Training - API & Web")
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const versionUrl = (id) => `${JIRA_HOST}/projects/${RELEASE_PROJECT}/versions/${id}/tab/release-report-all-issues`;

// ── Families ─────────────────────────────────────────────────────────
function versionFamily(name) {
  const n = (name || '').trim();
  if (/challenger/i.test(n))      return 'Challenger';
  if (/^internal api\b/i.test(n)) return 'Internal API';
  if (/^academy\b/i.test(n))      return 'Academy';
  if (/^ios\b/i.test(n))          return 'iOS';
  if (/^android\b/i.test(n))      return 'Android';
  if (/^api\b/i.test(n))          return 'API';
  if (/^web\b/i.test(n))          return 'Web';
  if (/^cms\b/i.test(n))          return 'CMS';
  return n.split(/\s+/)[0] || 'Release';
}
const isMobileFamily = (f) => f === 'iOS' || f === 'Android';
const appSide = (versionName) => /client/i.test(versionName) ? 'Client' : /coach/i.test(versionName) ? 'Coach' : null;

// Working days ahead (Mon–Fri) as ISO dates, starting today (VN).
function upcomingWorkdays(n) {
  const out = [];
  const d = vnNow();
  while (out.length < n + 1) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(isoDay(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// ── Jira reads ───────────────────────────────────────────────────────
async function listVersions() {
  const res = await axios.get(`${JIRA_HOST}/rest/api/3/project/${RELEASE_PROJECT}/versions`, { headers: headers() });
  return (res.data || []).filter(v => !v.archived && !v.released && !NOT_A_RELEASE.test(v.name || ''));
}

async function versionIssues(versionId) {
  const issues = [];
  let nextPageToken = null;
  for (let page = 0; page < 5; page++) {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/search/jql`, {
      params: { jql: `fixVersion = ${versionId} ORDER BY key ASC`, maxResults: 100,
                fields: 'summary,status,assignee,parent,issuetype', ...(nextPageToken ? { nextPageToken } : {}) },
      headers: headers(),
    });
    issues.push(...(res.data?.issues || []));
    nextPageToken = res.data?.nextPageToken || null;
    if (!nextPageToken || res.data?.isLast) break;
  }
  return issues;
}

// Versions releasing in the next N working days, grouped the way the PCs
// post them: one announcement per family per date (iOS Coach + iOS Client).
async function upcomingGroups({ workdays = LOOKAHEAD_WORKDAYS, onlyVersion = null } = {}) {
  const versions = await listVersions();
  const days = new Set(upcomingWorkdays(workdays));
  const pick = onlyVersion
    ? versions.filter(v => v.name.toLowerCase() === onlyVersion.toLowerCase() || v.name.toLowerCase().startsWith(onlyVersion.toLowerCase()))
    : versions.filter(v => v.releaseDate && days.has(v.releaseDate) && isRealVersionName(v.name));   // draft names are alerted, never drafted
  const groups = new Map();
  for (const v of pick) {
    const fam = versionFamily(v.name);
    const key = `${fam}|${v.releaseDate || 'no-date'}`;
    if (!groups.has(key)) groups.set(key, { key, family: fam, releaseDate: v.releaseDate || null, versions: [] });
    groups.get(key).versions.push({ id: v.id, name: v.name });
  }
  return [...groups.values()];
}

// ── Items: the epics of the cards in the version ─────────────────────
function itemLabel(issue) {
  const p = issue.fields?.parent;
  const epic = p?.fields?.summary || null;
  if (epic) {
    if (/fixes of misc|misc issue/i.test(epic)) return 'Misc issues';
    if (/client report/i.test(epic))            return 'Client report';
    if (/production audit/i.test(epic))         return 'Production audit fixes';
    if (/post-release fixes/i.test(epic))       return 'Post-release fixes';
    return epic.replace(/\s+/g, ' ').trim();
  }
  // No epic: name the card itself, minus its [Platform][Feature] tags
  const s = (issue.fields?.summary || issue.key).replace(/^(\s*\[[^\]]*\])+\s*/, '').trim();
  return /^hotfix\b/i.test(issue.fields?.summary || '') ? s : `${s}`;
}

async function slackIdForEmail(client, email) {
  if (!email) return null;
  try { return (await client.users.lookupByEmail({ email })).user?.id || null; } catch { return null; }
}

// ── Organizing fix versions ──────────────────────────────────────────
// Verified cards (QA Success) often stay on a placeholder version and miss
// the release. For each release version, find those whose title's platform
// tag matches it. Only QA Success — nothing unverified is suggested.
const PLACEHOLDER_VERSION_IDS = (process.env.PLACEHOLDER_VERSION_IDS || '12023,27643').split(',').map(s => s.trim());

function versionTagRegex(versionName) {
  const n = (versionName || '').toLowerCase();
  if (/challenger/.test(n))        return null;                     // CHAL cards can't take UP versions
  if (/^internal api\b/.test(n))   return /\[internal api\]/i;
  if (/^academy\b/.test(n))        return /\[academy[^\]]*\]/i;
  if (/^cms\b/.test(n))            return /\[cms\]/i;
  if (/^ios coach\b/.test(n))      return /\[ios(?: coach(?:\/client)?| coach\/client)?\]/i;
  if (/^ios client\b/.test(n))     return /\[ios(?: client| coach\/client)?\]/i;
  if (/^android coach\b/.test(n))  return /\[android(?: coach(?:\/client)?)?\]/i;
  if (/^android client\b/.test(n)) return /\[android(?: client| coach\/client)?\]/i;
  if (/^api\b/.test(n))            return /\[(?:api|be|backend)\]/i;
  if (/^web\b/.test(n))            return /\[(?:web|fe|frontend)\]/i;
  return null;
}

async function findCandidates(perVersion) {
  let pool = [];
  try {
    let nextPageToken = null;
    for (let page = 0; page < 3; page++) {
      const res = await axios.get(`${JIRA_HOST}/rest/api/3/search/jql`, {
        params: { jql: `project = ${RELEASE_PROJECT} AND fixVersion in (${PLACEHOLDER_VERSION_IDS.join(',')}) AND status = "QA Success" ORDER BY updated DESC`,
                  maxResults: 100, fields: 'summary,fixVersions,assignee', ...(nextPageToken ? { nextPageToken } : {}) },
        headers: headers(),
      });
      pool.push(...(res.data?.issues || []));
      nextPageToken = res.data?.nextPageToken || null;
      if (!nextPageToken || res.data?.isLast) break;
    }
  } catch (err) {
    console.warn('[Release] candidate lookup failed:', err.response?.status || err.message);
  }
  return perVersion.map(v => {
    const re = versionTagRegex(v.name);
    const issues = re ? pool.filter(i => re.test(i.fields?.summary || '')) : [];
    return { versionId: String(v.id), versionName: v.name, issues };
  }).filter(c => c.issues.length);
}

// Put a card on a release version: drop placeholder versions, keep any
// other real version it already has, add the target.
async function moveToVersion(issueKey, versionId) {
  const res = await axios.get(`${JIRA_HOST}/rest/api/3/issue/${issueKey}`, { params: { fields: 'fixVersions' }, headers: headers() });
  const keep = (res.data?.fields?.fixVersions || [])
    .filter(v => !PLACEHOLDER_VERSION_IDS.includes(String(v.id)) && !NOT_A_RELEASE.test(v.name || '') && String(v.id) !== String(versionId))
    .map(v => ({ id: String(v.id) }));
  await axios.put(`${JIRA_HOST}/rest/api/3/issue/${issueKey}`, { fields: { fixVersions: [...keep, { id: String(versionId) }] } },
    { headers: { ...headers(), 'Content-Type': 'application/json' } });
}

// Build the whole draft for a group
async function buildDraft(client, group) {
  const perVersion = [];
  const allIssues = [];
  for (const v of group.versions) {
    const issues = await versionIssues(v.id);
    perVersion.push({ ...v, issues });
    allIssues.push(...issues.map(i => ({ ...i, _version: v.name })));
  }

  // Items — mobile: grouped per app when both apps ship
  const itemsBySide = new Map();
  for (const pv of perVersion) {
    const side = isMobileFamily(group.family) ? (appSide(pv.name) || 'App') : 'All';
    if (!itemsBySide.has(side)) itemsBySide.set(side, new Set());
    for (const i of pv.issues) itemsBySide.get(side).add(itemLabel(i));
  }
  // Put "Misc issues" / "Client report" last, as the PCs do
  const order = (labels) => [...labels].sort((a, b) =>
    (/^(misc issues|client report|production audit fixes|post-release fixes)$/i.test(a) ? 1 : 0) - (/^(misc issues|client report|production audit fixes|post-release fixes)$/i.test(b) ? 1 : 0));

  // PIC: distinct assignees
  const assignees = new Map();
  for (const i of allIssues) {
    const a = i.fields?.assignee;
    if (a && !assignees.has(a.accountId)) assignees.set(a.accountId, { name: a.displayName, email: a.emailAddress || null });
  }
  const pic = [];
  for (const a of assignees.values()) {
    const id = await slackIdForEmail(client, a.email);
    pic.push(id ? `<@${id}>` : a.name);
  }

  // Readiness
  const notReady = allIssues.filter(i => !DONE_STATUSES.has((i.fields?.status?.name || '').toLowerCase()));
  const notReadyLines = [];
  for (const i of notReady.slice(0, 15)) {
    const a = i.fields?.assignee;
    const id = a ? await slackIdForEmail(client, a.emailAddress) : null;
    notReadyLines.push(`• <${JIRA_HOST}/browse/${i.key}|${i.key}> ${i.fields?.status?.name || '?'} · ${id ? `<@${id}>` : (a?.displayName || 'unassigned')}`);
  }

  const candidates = await findCandidates(perVersion);
  return {
    group, perVersion, itemsBySide: [...itemsBySide.entries()].map(([side, set]) => [side, order(set)]),
    pic, total: allIssues.length, notReady, notReadyLines, candidates,
    force: null, notes: null,
  };
}

// ── Rendering: the announcement, in the team's format ────────────────
function renderAnnouncement(d) {
  const g = d.group;
  const mobile = isMobileFamily(g.family);
  const tags = (FAMILY_GROUPS[g.family] || []).map(s => `<!subteam^${s}>`).join(' ');
  const lines = [];
  lines.push(`*Em gửi release cho ${g.family === 'Challenger' ? '[CHALLENGER APP]' : g.family}* ${tags}`.trim());
  if (d.perVersion.length === 1) {
    lines.push(`• Fix version: <${versionUrl(d.perVersion[0].id)}|${esc(d.perVersion[0].name)}>`);
  } else {
    lines.push('• Fix version:');
    for (const v of d.perVersion) lines.push(`    ◦ ${mobile && appSide(v.name) ? `${appSide(v.name)}: ` : ''}<${versionUrl(v.id)}|${esc(v.name)}>`);
  }
  lines.push(`• ${mobile ? 'Submit date' : 'Release date'}: ${g.releaseDate ? prettyDate(g.releaseDate) : 'TBD'}`);
  if (mobile) lines.push(`• Description: ${d.notes || 'TBD'}`);
  lines.push('• Items:');
  const multiSide = d.itemsBySide.length > 1;
  for (const [side, labels] of d.itemsBySide) {
    if (multiSide) lines.push(`\`${side}\``);
    for (const l of labels.slice(0, 12)) lines.push(`    ◦ ${l}`);
    if (labels.length > 12) lines.push(`    ◦ …and ${labels.length - 12} more`);
  }
  if (!d.itemsBySide.length || d.total === 0) lines.push('    ◦ (no cards in this version yet)');
  if (d.pic.length) lines.push(`• PIC: ${d.pic.join(' ')}`);
  if (mobile) lines.push(`• Set up Force/Optional Update: ${d.force || 'TBD'}`);
  lines.push(`cc <!subteam^${CC_GROUP}>`);
  return lines.join('\n');
}

// Drafts must never notify anyone: show group and people tags as plain
// text. Only the approved post (renderAnnouncement) carries real mentions.
let _groupHandles = null;
async function groupHandles(client) {
  if (_groupHandles) return _groupHandles;
  _groupHandles = {};
  try {
    const res = await client.usergroups.list({ include_disabled: false });
    for (const g of res.usergroups || []) _groupHandles[g.id] = g.handle || g.name;
  } catch (_) { /* needs usergroups:read — fall back to a generic label */ }
  return _groupHandles;
}
async function neutralize(client, text) {
  const handles = await groupHandles(client);
  const uids = [...new Set([...(text || '').matchAll(/<@([A-Z0-9]+)>/g)].map(m => m[1]))];
  await lib.warmUserNames(client, uids).catch(() => {});
  return (text || '')
    .replace(/<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g, (m, id, label) => `\`@${(label || handles[id] || 'group').replace(/^@/, '')}\``)
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (m, id) => lib.replaceMentionsCached(`<@${id}>`))
    .replace(/<!(here|channel|everyone)>/g, '`@$1`');
}

function renderReadiness(d) {
  if (!d.total) return '_No cards in this version yet._';
  const ready = d.total - d.notReady.length;
  if (!d.notReady.length) return `*Readiness:* ${d.total === 1 ? 'the only card is' : `all ${d.total} cards are`} QA Success ✅`;
  return `*Readiness:* ${ready}/${d.total} cards ready. Not ready yet:\n${d.notReadyLines.join('\n')}` +
    (d.notReady.length > d.notReadyLines.length ? `\n_…and ${d.notReady.length - d.notReadyLines.length} more_` : '');
}

// ── Draft state + approval ───────────────────────────────────────────
const DRAFTS    = new Map();   // draftId → { d, channel, threadTs, ts, groupKey }
const ANNOUNCED = new Map();   // groupKey → { ts, versionIds, releaseDate }
const SKIPPED   = new Set();   // groupKey (for this process life)
const POSTED    = new Map();   // draftId → { by, link } — for late clicks on an approved draft
const REMINDED  = new Set();
const READINESS_POSTED = new Map();   // groupKey → last ISO day posted

function draftBlocks(id, d) {
  const mobile = isMobileFamily(d.group.family);
  const missing = [];
  if (mobile && !d.notes) missing.push('release notes');
  if (mobile && !d.force) missing.push('force/optional update');
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Release draft — ${d.group.family} · ${d.group.releaseDate ? prettyDate(d.group.releaseDate) : 'no date'}*\nNot posted yet — nobody has been notified. Approve to post it in <#${RELEASE_CHANNEL}>.${d.note ? `\n_${d.note}_` : ''}` } },
    { type: 'section', text: { type: 'mrkdwn', text: (d._preview || '').substring(0, 2900) } },
    { type: 'section', text: { type: 'mrkdwn', text: (d._readinessPreview || '').substring(0, 2900) } },
  ];
  for (const c of d.candidates || []) {
    const list = c.issues.slice(0, 10).map(i => `• <${JIRA_HOST}/browse/${i.key}|${i.key}> ${lib.postLabel(i.fields?.summary || '')}`).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `*Verified but not in a release* — ${c.issues.length} QA Success card(s) matching ${c.versionName} are still on a placeholder version:\n${list}${c.issues.length > 10 ? `\n_…and ${c.issues.length - 10} more_` : ''}`.substring(0, 2900) } });
    blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'rel_addfix', value: `${id}|${c.versionId}`,
      text: { type: 'plain_text', text: `Add ${c.issues.length} to ${c.versionName}`.substring(0, 75) } }] });
  }
  if (missing.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Still needs your decision: ${missing.join(' and ')}.` }] });
  const elements = [];
  if (mobile) {
    elements.push({
      type: 'static_select', action_id: 'rel_force', placeholder: { type: 'plain_text', text: d.force || 'Force / Optional update' },
      options: ['Optional Update', 'Force Update', 'N/A'].map(o => ({ text: { type: 'plain_text', text: o }, value: `${id}|${o}` })),
    });
    elements.push({ type: 'button', action_id: 'rel_notes', value: id, text: { type: 'plain_text', text: d.notes ? 'Edit release notes' : 'Set release notes' } });
  }
  elements.push({ type: 'button', style: 'primary', action_id: 'rel_approve', value: id, text: { type: 'plain_text', text: 'Approve & post' } });
  elements.push({ type: 'button', action_id: 'rel_skip', value: id, text: { type: 'plain_text', text: 'Skip' } });
  blocks.push({ type: 'actions', elements });
  return blocks;
}

async function prepPreview(client, d) {
  d._preview = await neutralize(client, renderAnnouncement(d));
  d._readinessPreview = await neutralize(client, renderReadiness(d));
}

// A draft is a REPLY in a thread (the requester's message, or the daily
// review thread) — never a top-level post and never a DM.
async function sendDraft(client, d, { channel, threadTs }) {
  const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  await prepPreview(client, d);
  const res = await client.chat.postMessage({
    channel, thread_ts: threadTs, unfurl_links: false, unfurl_media: false,
    text: `Release draft — ${d.group.family} ${d.group.releaseDate || ''}`,
    blocks: draftBlocks(id, d),
  });
  DRAFTS.set(id, { d, channel, threadTs, ts: res.ts, groupKey: d.group.key });
  return id;
}

async function refreshDraft(client, id) {
  const st = DRAFTS.get(id);
  if (!st) return;
  await prepPreview(client, st.d);
  await client.chat.update({ channel: st.channel, ts: st.ts, text: 'Release draft', blocks: draftBlocks(id, st.d) }).catch(() => {});
}

// Has anyone (a PC) already announced this version in the channel?
async function alreadyAnnouncedInChannel(client, group) {
  try {
    const oldest = String((Date.now() - 21 * 86400 * 1000) / 1000);
    const res = await client.conversations.history({ channel: RELEASE_CHANNEL, oldest, limit: 200 });
    const ids = group.versions.map(v => `/versions/${v.id}`);
    const names = group.versions.map(v => v.name.toLowerCase());
    return (res.messages || []).some(m => {
      const t = (m.text || '').toLowerCase();
      return ids.some(x => t.includes(x)) || names.some(n => t.includes(n));
    });
  } catch { return false; }
}

// ── Fix version check ───────────────────────────────────────────────
// Three problems a PC should fix before a release can be coordinated:
//   · draft name  — not "<Platform> <number>" (PC hasn't decided yet)
//   · overdue     — release date passed, never marked released
//   · no date     — has cards but no release date
// Only versions that actually hold cards are reported.
async function hasCards(versionId) {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/search/jql`, {
      params: { jql: `fixVersion = ${versionId}`, maxResults: 50, fields: 'key' }, headers: headers(),
    });
    const n = (res.data?.issues || []).length;
    return { n, more: !!res.data?.nextPageToken };
  } catch { return { n: 0, more: false }; }
}

async function versionCheck() {
  const today = isoDay(vnNow());
  const versions = await listVersions();
  const flags = { draft: [], overdue: [], noDate: [] };
  for (const v of versions) {
    const draft = !isRealVersionName(v.name);
    const overdue = !!v.releaseDate && v.releaseDate < today;
    const noDate = !v.releaseDate;
    if (!draft && !overdue && !noDate) continue;
    const c = await hasCards(v.id);
    if (!c.n) continue;                                        // empty versions aren't worth anyone's time
    const entry = { id: String(v.id), name: v.name, date: v.releaseDate || null, cards: c.more ? `${c.n}+` : String(c.n) };
    if (draft) flags.draft.push(entry);
    else if (overdue) flags.overdue.push(entry);
    else flags.noDate.push(entry);
  }
  flags.overdue.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return flags;
}

function renderVersionCheck(flags) {
  const line = (e) => `• <${versionUrl(e.id)}|${esc(e.name)}> · ${e.cards} card${e.cards === '1' ? '' : 's'}${e.date ? ` · ${prettyDate(e.date)}` : ''}`;
  const section = (title, hint, list) => list.length
    ? `*${title}* — ${hint}\n${list.slice(0, 10).map(line).join('\n')}${list.length > 10 ? `\n_…and ${list.length - 10} more_` : ''}` : null;
  const parts = [
    section('Draft version names', "not a real \"<Platform> <number>\" version yet — the PC still needs to decide it", flags.draft),
    section('Release date passed', 'still not marked released in Jira — release it, or move the date', flags.overdue),
    section('No release date', 'cards are assigned but the version has no date', flags.noDate),
  ].filter(Boolean);
  return parts.join('\n\n');
}

const checkSignature = (f) => JSON.stringify([f.draft, f.overdue, f.noDate].map(l => l.map(e => `${e.id}:${e.date}`).sort()));
let _lastCheck = { sig: null, day: null };

async function alertVersionIssues(client, { force = false, channel = RELEASE_REVIEW_CHANNEL, threadTs = null } = {}) {
  const flags = await versionCheck();
  const total = flags.draft.length + flags.overdue.length + flags.noDate.length;
  if (!total) {
    if (force) await client.chat.postMessage({ channel, thread_ts: threadTs, text: 'Fix versions look clean — no draft names, overdue or undated versions with cards.' });
    return;
  }
  // Repeat only when something changed, or every 2 working days while unresolved
  const sig = checkSignature(flags), today = isoDay(vnNow());
  if (!force && sig === _lastCheck.sig && businessDaysSince(_lastCheck.day) < 2) return;
  _lastCheck = { sig, day: today };
  await client.chat.postMessage({
    channel, thread_ts: threadTs, unfurl_links: false, unfurl_media: false,
    text: `${threadTs ? '' : `${notifyTags()} `}*Fix version check* — ${total} version${total > 1 ? 's need' : ' needs'} a PC's attention before release:\n\n${renderVersionCheck(flags)}`,
  });
}

function businessDaysSince(isoDate) {
  if (!isoDate) return Infinity;
  let n = 0;
  const d = new Date(`${isoDate}T00:00:00Z`), end = new Date(`${isoDay(vnNow())}T00:00:00Z`);
  while (d < end) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

// ── Scheduled work ───────────────────────────────────────────────────
async function draftUpcoming(client, logger = console) {
  const groups = await upcomingGroups();
  const ready = [];
  for (const g of groups) {
    if (ANNOUNCED.has(g.key) || SKIPPED.has(g.key)) continue;
    if ([...DRAFTS.values()].some(s => s.groupKey === g.key)) continue;
    if (await alreadyAnnouncedInChannel(client, g)) { ANNOUNCED.set(g.key, { ts: null, versionIds: g.versions.map(v => v.id), releaseDate: g.releaseDate, byPC: true }); continue; }
    const d = await buildDraft(client, g);
    if (!d.total) continue;                               // empty in UP (e.g. another team's version) → nothing to release
    ready.push(d);
  }
  if (!ready.length) return;
  // One short top-level message for the approver; every draft lives in its thread
  const list = ready.map(d => `• ${d.group.family} · ${d.group.releaseDate ? prettyDate(d.group.releaseDate) : 'no date'} — ${d.perVersion.map(v => v.name).join(' / ')}`).join('\n');
  const head = await client.chat.postMessage({
    channel: RELEASE_REVIEW_CHANNEL, unfurl_links: false,
    text: `${notifyTags()} ${ready.length} release${ready.length > 1 ? 's are' : ' is'} due soon — draft${ready.length > 1 ? 's' : ''} in this thread for review. Nothing is posted to <#${RELEASE_CHANNEL}> until approved.\n${list}`,
  });
  for (const d of ready) await sendDraft(client, d, { channel: RELEASE_REVIEW_CHANNEL, threadTs: head.ts });
  logger.info?.(`[Release] Sent ${ready.length} release draft(s) for approval`);
}

async function remindPending(client) {
  const tomorrow = upcomingWorkdays(1)[1];
  const due = [...DRAFTS.entries()].filter(([id, st]) => st.d.group.releaseDate === tomorrow && !REMINDED.has(id));
  if (!due.length) return;
  const lines = due.map(([id, st]) => {
    REMINDED.add(id);
    const mobile = isMobileFamily(st.d.group.family);
    const missing = [mobile && !st.d.notes ? 'release notes' : null, mobile && !st.d.force ? 'force/optional update' : null].filter(Boolean);
    const notReady = st.d.notReady?.length ? ` · ${st.d.notReady.length} card(s) not QA Success yet` : '';
    return `• <${threadLink(st.channel, st.ts, st.threadTs)}|${st.d.group.family} — ${st.d.perVersion.map(v => v.name).join(' / ')}>` +
      `${missing.length ? ` · still TBD: ${missing.join(', ')}` : ''}${notReady}`;
  });
  await client.chat.postMessage({
    channel: RELEASE_REVIEW_CHANNEL, unfurl_links: false,
    text: `${notifyTags()} ${due.length} release${due.length > 1 ? 's are' : ' is'} due tomorrow (${prettyDate(tomorrow)}) and not approved yet:\n${lines.join('\n')}`,
  }).catch(err => console.warn('[Release] reminder failed:', err.data?.error || err.message));
}

async function postReadiness(client, logger = console) {
  const today = isoDay(vnNow());
  for (const [key, a] of ANNOUNCED) {
    if (!a.ts || a.byPC) continue;                          // only threads the bot posted
    if (!a.releaseDate || a.releaseDate < today) continue;
    if (READINESS_POSTED.get(key) === today) continue;
    READINESS_POSTED.set(key, today);
    const [family] = key.split('|');
    const d = await buildDraft(client, { key, family, releaseDate: a.releaseDate, versions: a.versionIds.map(id => ({ id, name: a.versionNames?.[id] || id })) });
    const isReleaseDay = a.releaseDate === today;
    if (!d.notReady.length && !isReleaseDay) continue;       // quiet when fully ready, until release day
    await client.chat.postMessage({
      channel: RELEASE_CHANNEL, thread_ts: a.ts, unfurl_links: false,
      text: d.notReady.length
        ? `${isReleaseDay ? '*Release day* — ' : ''}${renderReadiness(d)}`
        : `*Release day* — ${d.total === 1 ? 'the only card is' : `all ${d.total} cards are`} QA Success ✅`,
    }).catch(err => logger.warn?.('[Release] readiness post failed:', err.message));
  }
}

// After a restart: find the announcements the bot posted, so readiness
// checks continue in their threads.
async function recoverAnnounced(client) {
  try {
    const { user_id: botUid } = await client.auth.test();
    const oldest = String((Date.now() - 21 * 86400 * 1000) / 1000);
    const res = await client.conversations.history({ channel: RELEASE_CHANNEL, oldest, limit: 200 });
    const versions = await listVersions();
    const byId = new Map(versions.map(v => [String(v.id), v]));
    for (const m of res.messages || []) {
      if (m.user !== botUid || !/Em gửi release cho/.test(m.text || '')) continue;
      const ids = [...(m.text || '').matchAll(/\/versions\/(\d+)/g)].map(x => x[1]).filter(id => byId.has(id));
      if (!ids.length) continue;
      const v0 = byId.get(ids[0]);
      const key = `${versionFamily(v0.name)}|${v0.releaseDate || 'no-date'}`;
      ANNOUNCED.set(key, { ts: m.ts, versionIds: ids, releaseDate: v0.releaseDate, versionNames: Object.fromEntries(ids.map(i => [i, byId.get(i).name])) });
    }
    console.log(`[Release] Recovered ${ANNOUNCED.size} announcement(s) for readiness tracking`);
  } catch (err) {
    console.warn('[Release] recovery failed:', err.message);
  }
}

let _lastDraftDay = null, _lastReadyDay = null, _lastRemindDay = null;
function startScheduler(client) {
  setTimeout(() => recoverAnnounced(client), 20000);
  setInterval(async () => {
    try {
      const vn = vnNow(), day = isoDay(vn), dow = vn.getUTCDay(), hm = vn.getUTCHours() * 60 + vn.getUTCMinutes();
      if (dow === 0 || dow === 6) return;
      if (hm >= 9 * 60 + 30 && _lastDraftDay !== day) { _lastDraftDay = day; await draftUpcoming(client); await alertVersionIssues(client); }
      if (hm >= 10 * 60 && _lastReadyDay !== day)     { _lastReadyDay = day; await postReadiness(client); }
      if (hm >= 15 * 60 && _lastRemindDay !== day)    { _lastRemindDay = day; await remindPending(client); }
    } catch (err) {
      console.warn('[Release] scheduler error:', err.message);
    }
  }, 10 * 60 * 1000).unref?.();
}

// ── On-demand: "@QA Agent draft release for Web 4.37.1" ──────────────
const VERSION_CHECK_RE = /\b(?:check|review|audit)\b[\s\S]*?\b(?:fix\s*versions?|versions?)\b/i;
function isVersionCheckCommand(text) { return VERSION_CHECK_RE.test((text || '').replace(/<@[A-Z0-9]+>/g, '')); }
const RELEASE_CMD_RE = /\b(?:draft|prepare)\s+(?:the\s+|a\s+)?(?:next\s+)?release\b|\brelease\s+(?:draft|announcement|plan)s?\b/i;
function isReleaseCommand(text) { const t = (text || '').replace(/<@[A-Z0-9]+>/g, ''); return RELEASE_CMD_RE.test(t) || VERSION_CHECK_RE.test(t); }

async function handleCommand({ event, client, logger }) {
  const tTs = event.thread_ts || event.ts;
  if (isVersionCheckCommand(event.text)) {
    await alertVersionIssues(client, { force: true, channel: event.channel, threadTs: tTs });
    return;
  }
  const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const vMatch = text.match(/\b((?:iOS|Android)\s+(?:Coach|Client)|Internal API|Academy\s+(?:Web|CMS)|Web Challenger|API|Web|CMS)\s+(\d+(?:\.\d+){1,3})\b/i);
  let groups;
  try {
    groups = vMatch ? await upcomingGroups({ onlyVersion: `${vMatch[1]} ${vMatch[2]}` }) : await upcomingGroups();
  } catch (err) {
    await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: `I couldn't read the release versions from Jira: \`${err.message}\`` });
    return;
  }
  if (!groups.length) {
    await client.chat.postMessage({ channel: event.channel, thread_ts: tTs,
      text: vMatch ? `I couldn't find an unreleased version named ${vMatch[1]} ${vMatch[2]}.` : `No releases scheduled in the next ${LOOKAHEAD_WORKDAYS} working days.` });
    return;
  }
  for (const g of groups) {
    const d = await buildDraft(client, g);
    if (!d.total) d.note = `${g.versions.map(v => v.name).join(' / ')} has no cards in ${RELEASE_PROJECT} — it may belong to another team's project (e.g. PAY), or cards aren't assigned to it yet.`;
    else if (await alreadyAnnouncedInChannel(client, g)) d.note = 'This version already appears in a release post in the channel — check before posting it again.';
    await sendDraft(client, d, { channel: event.channel, threadTs: tTs });
  }
}

// ── Interactions ─────────────────────────────────────────────────────
function register(slackApp) {
  slackApp.action('rel_force', async ({ ack, body, client }) => {
    await ack();
    const [id, choice] = (body.actions?.[0]?.selected_option?.value || '').split('|');
    const st = DRAFTS.get(id);
    if (!st) return;
    st.d.force = choice;
    await refreshDraft(client, id);
  });

  slackApp.action('rel_notes', async ({ ack, body, client }) => {
    await ack();
    const id = body.actions?.[0]?.value;
    const st = DRAFTS.get(id);
    if (!st) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal', callback_id: 'rel_notes_submit', private_metadata: id,
        title: { type: 'plain_text', text: 'Release notes' },
        submit: { type: 'plain_text', text: 'Save' },
        blocks: [{ type: 'input', block_id: 'notes', label: { type: 'plain_text', text: 'Store description' },
          element: { type: 'plain_text_input', action_id: 'v', multiline: true, initial_value: st.d.notes || '',
            placeholder: { type: 'plain_text', text: 'e.g. Fixes and improvements.' } } }],
      },
    }).catch(() => {});
  });

  slackApp.view('rel_notes_submit', async ({ ack, view, client }) => {
    await ack();
    const id = view.private_metadata;
    const st = DRAFTS.get(id);
    if (!st) return;
    st.d.notes = (view.state?.values?.notes?.v?.value || '').trim() || null;
    await refreshDraft(client, id);
  });

  slackApp.action('rel_addfix', async ({ ack, body, client, logger }) => {
    await ack();
    const [id, versionId] = (body.actions?.[0]?.value || '').split('|');
    const st = DRAFTS.get(id);
    if (!st || !RELEASE_APPROVERS.includes(body.user?.id)) return;
    const cand = (st.d.candidates || []).find(c => c.versionId === versionId);
    if (!cand) return;
    const moved = [], failed = [];
    for (const i of cand.issues) {
      try { await moveToVersion(i.key, versionId); moved.push(i.key); }
      catch (err) { failed.push(i.key); logger?.warn?.(`[Release] move ${i.key} → ${cand.versionName} failed:`, err.response?.data || err.message); }
    }
    // Rebuild from Jira so items, PIC and readiness include the moved cards
    const fresh = await buildDraft(client, st.d.group);
    fresh.force = st.d.force; fresh.notes = st.d.notes;
    st.d = fresh;
    await refreshDraft(client, id);
    await client.chat.postMessage({ channel: st.channel, thread_ts: st.ts,
      text: `Moved ${moved.length} card(s) to ${cand.versionName}${moved.length ? `: ${moved.join(', ')}` : ''}${failed.length ? `\nCouldn't move: ${failed.join(', ')}` : ''}` }).catch(() => {});
  });

  slackApp.action('rel_skip', async ({ ack, body, client }) => {
    await ack();
    const id = body.actions?.[0]?.value;
    const st = DRAFTS.get(id);
    if (!st) {                                            // expired (restart) → just remove the draft
      await client.chat.delete({ channel: body.channel.id, ts: body.message.ts }).catch(() => {});
      return;
    }
    SKIPPED.add(st.groupKey);
    DRAFTS.delete(id);
    await client.chat.update({ channel: st.channel, ts: st.ts, text: 'Skipped',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Skipped — the ${st.d.group.family} release draft wasn't posted.` } }] }).catch(() => {});
  });

  slackApp.action('rel_approve', async ({ ack, body, client, logger }) => {
    await ack();
    const id = body.actions?.[0]?.value;
    const st = DRAFTS.get(id);
    if (!st && POSTED.has(id)) {
      const p = POSTED.get(id);
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: body.message?.thread_ts,
        text: `Already approved by <@${p.by}> and posted — <${p.link}|view>.` }).catch(() => {});
      return;
    }
    if (!st) {
      await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message.thread_ts || body.message.ts,
        text: 'That draft expired (I restarted), so I didn\'t post it. Ask me to "draft release for <version>" again — or press Skip to remove it.' }).catch(() => {});
      return;
    }
    if (!RELEASE_APPROVERS.includes(body.user?.id)) {
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: body.message?.thread_ts,
        text: `Only ${RELEASE_APPROVERS.map(u => `<@${u}>`).join(' ')} can approve release posts.` }).catch(() => {});
      return;
    }
    // Two approvers → guard against both clicking at once (posting takes a
    // few seconds while Jira is re-read)
    if (st.approving) {
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: body.message?.thread_ts,
        text: `<@${st.approving}> is already posting this release.` }).catch(() => {});
      return;
    }
    st.approving = body.user.id;
    // Re-read Jira so the post reflects the latest state
    const fresh = await buildDraft(client, st.d.group);
    fresh.force = st.d.force; fresh.notes = st.d.notes;
    const posted = await client.chat.postMessage({ channel: RELEASE_CHANNEL, text: renderAnnouncement(fresh), unfurl_links: false, unfurl_media: false });
    ANNOUNCED.set(st.groupKey, { ts: posted.ts, versionIds: fresh.perVersion.map(v => String(v.id)), releaseDate: fresh.group.releaseDate,
      versionNames: Object.fromEntries(fresh.perVersion.map(v => [String(v.id), v.name])) });
    DRAFTS.delete(id);
    const link = `https://everfitt.slack.com/archives/${RELEASE_CHANNEL}/p${posted.ts.replace('.', '')}`;
    POSTED.set(id, { by: body.user.id, link });
    await client.chat.update({ channel: st.channel, ts: st.ts, text: 'Posted',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Approved by <@${body.user.id}> and posted the ${fresh.group.family} release to <#${RELEASE_CHANNEL}> — <${link}|view>. I'll post readiness in its thread each morning until release day.` } }] }).catch(() => {});
    logger?.info?.(`[Release] Approved and posted ${st.groupKey}`);
  });
}

module.exports = {
  register, startScheduler, isReleaseCommand, handleCommand,
  // exported for tests
  versionFamily, upcomingWorkdays, itemLabel, renderAnnouncement, renderReadiness, buildDraft, upcomingGroups,
  versionTagRegex, findCandidates, moveToVersion, PLACEHOLDER_VERSION_IDS, draftUpcoming, remindPending,
  isRealVersionName, versionCheck, renderVersionCheck, alertVersionIssues,
};
