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

// Ready to ship = QA Success (or Done / Released / Closed). 'QA Completed'
// is NOT the final state — those cards still need QA Success.
const DONE_STATUSES = new Set(['qa success', 'done', 'released', 'closed']);
const WONT_SHIP = new Set(['will not fix']);        // shouldn't be in a release at all
const NOT_A_RELEASE = /^(?:n\s*\/?\s*a|to be confirmed|will not release)\b|\(tbd\)|\btbd\b/i;   // placeholders, not releases
// A real release version is "<Platform> <number>" — e.g. iOS Coach 2.83.1,
// Web 4.37.1, Academy CMS 0.2.4, API Challenger 1.0.0. Two-part numbers
// (iOS Coach 2.83) are the team's normal minor format. Anything else —
// "Training - Mobile cards" — is a PC's draft placeholder.
// White Label versions may carry a build suffix: 'iOS White Label 3.88.3 (1)'.
// 'White Label Client …' is NOT a format — White Label versions have no app side.
const VALID_VERSION_RE = /^(?:(?:(?:iOS|Android)\s+(?:Coach|Client)|Web|API|Internal API|Academy\s+(?:Web|CMS)|CMS|MP API|Landing|Middleware|(?:Web|API|iOS|Android)\s+Challenger)\s+\d+(?:\.\d+){1,3}|(?:iOS|Android)\s+White Label\s+\d+(?:\.\d+){1,3}(?:\s*\(\d+\))?)$/i;
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
  const wontShip = allIssues.filter(i => WONT_SHIP.has((i.fields?.status?.name || '').toLowerCase()));
  const notReady = allIssues.filter(i => { const s = (i.fields?.status?.name || '').toLowerCase(); return !DONE_STATUSES.has(s) && !WONT_SHIP.has(s); });
  const notReadyLines = [];
  for (const i of notReady.slice(0, 15)) {
    const a = i.fields?.assignee;
    const id = a ? await slackIdForEmail(client, a.emailAddress) : null;
    notReadyLines.push(`• <${JIRA_HOST}/browse/${i.key}|${i.key}> ${i.fields?.status?.name || '?'} · ${id ? `<@${id}>` : (a?.displayName || 'unassigned')}`);
  }

  const candidates = await findCandidates(perVersion);
  return {
    group, perVersion, itemsBySide: [...itemsBySide.entries()].map(([side, set]) => [side, order(set)]),
    pic, total: allIssues.length, notReady, notReadyLines, candidates, wontShip: wontShip.map(i => i.key),
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
  const wont = d.wontShip?.length
    ? `\n_${d.wontShip.length} card${d.wontShip.length > 1 ? 's are' : ' is'} Will Not Fix — move ${d.wontShip.length > 1 ? 'them' : 'it'} out of the version: ${d.wontShip.join(', ')}_` : '';
  const shipping = d.total - (d.wontShip?.length || 0);
  if (!d.notReady.length) return `*Readiness:* ${shipping === 1 ? 'the only card is' : `all ${shipping} cards are`} QA Success ✅${wont}`;
  // Group by status so 'QA Completed' stands out from real in-progress work
  const byStatus = {};
  for (const i of d.notReady) { const s = i.fields?.status?.name || '?'; byStatus[s] = (byStatus[s] || 0) + 1; }
  const breakdown = Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ');
  return `*Readiness:* ${shipping - d.notReady.length}/${shipping} cards QA Success — not ready yet (${breakdown}):\n${d.notReadyLines.join('\n')}` +
    (d.notReady.length > d.notReadyLines.length ? `\n_…and ${d.notReady.length - d.notReadyLines.length} more_` : '') + wont;
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

// ── Evidence of shipping: #release_production_request ────────────────
// The release workflow posts "<Platform> Production Release Request: … for
// platform: Web - version: v4.36.0" and the dev clicks Continue as the
// release goes out. A request with a Continue click = shipped to production.
const PROD_RELEASE_CHANNEL = process.env.PROD_RELEASE_CHANNEL || 'CTT4J643Y';   // #release_production_request

function requestToVersionNames(platform, version) {
  const p = (platform || '').toLowerCase().replace(/[^a-z]/g, '');
  const raw = String(version || '');
  const side = /^client_?/i.test(raw) ? 'Client' : /^coach_?/i.test(raw) ? 'Coach' : null;
  const num = (raw.match(/(\d+(?:\.\d+){1,3})/) || [])[1];
  if (!num) return [];
  const fams = p === 'web' ? ['Web']
    : p === 'api' ? ['API']
    : p === 'internalapi' ? ['Internal API']
    : p === 'academyweb' ? ['Academy Web', 'Academy CMS']       // the workflow uses academy-web for both
    : p === 'academycms' ? ['Academy CMS']
    : p === 'cms' ? ['CMS']
    : p === 'ios' ? (side ? [`iOS ${side}`] : ['iOS Coach', 'iOS Client'])
    : p === 'android' ? (side ? [`Android ${side}`] : ['Android Coach', 'Android Client'])
    : [];                                                        // payment-api, olly, landing page: not UP
  return fams.map(f => `${f} ${num}`);
}

async function shippedRequests(client, days = 45) {
  const oldest = String((Date.now() - days * 86400 * 1000) / 1000);
  const out = [];                                              // newest first
  let cursor;
  for (let page = 0; page < 5; page++) {
    let res;
    try { res = await client.conversations.history({ channel: PROD_RELEASE_CHANNEL, oldest, limit: 200, cursor }); }
    catch (err) { console.warn('[Release] #release_production_request read failed:', err.data?.error || err.message); break; }
    for (const m of res.messages || []) {
      const t = JSON.stringify([m.text || '', m.blocks || [], m.attachments || []]);
      if (!/Production Release Request/i.test(t)) continue;
      const pv = t.match(/for platform:\s*(.+?)\s*-\s*version:\s*([A-Za-z_]*v?\d+(?:\.\d+){1,3})/i);
      if (!pv) continue;
      const click = t.match(/<@([A-Z0-9]+)(?:\|[^>]*)?>\s*clicked\s*\*?`?Continue/i);
      if (!click) continue;                                      // never continued → not shipped
      out.push({ names: requestToVersionNames(pv[1], pv[2]), by: click[1], ts: m.ts,
                 day: isoDay(new Date(parseFloat(m.ts) * 1000 + 7 * 3600 * 1000)),
                 link: `https://everfitt.slack.com/archives/${PROD_RELEASE_CHANNEL}/p${m.ts.replace('.', '')}` });
    }
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
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

// Marked released in Jira, but some cards aren't finished (status category
// isn't Done — QA Success and Done are; QA Ready / In Progress aren't).
// One query across released versions; only versions released in the last
// RELEASED_LOOKBACK_DAYS are reported.
async function releasedButUnfinished() {
  const LOOKBACK = parseInt(process.env.RELEASED_LOOKBACK_DAYS || '45', 10);
  const since = isoDay(new Date(vnNow().getTime() - LOOKBACK * 86400 * 1000));
  const byVersion = new Map();              // versionId → { id, name, date, open: [issues] }
  try {
    let nextPageToken = null;
    for (let page = 0; page < 10; page++) {
      const res = await axios.get(`${JIRA_HOST}/rest/api/3/search/jql`, {
        params: { jql: `project = ${RELEASE_PROJECT} AND fixVersion in releasedVersions(${RELEASE_PROJECT}) AND (statusCategory != Done OR status = "QA Completed") ORDER BY key ASC`,
                  maxResults: 100, fields: 'summary,status,assignee,fixVersions', ...(nextPageToken ? { nextPageToken } : {}) },
        headers: headers(),
      });
      for (const i of res.data?.issues || []) {
        for (const v of i.fields?.fixVersions || []) {
          if (!v.released || v.archived || !v.releaseDate || v.releaseDate < since) continue;
          if (!byVersion.has(String(v.id))) byVersion.set(String(v.id), { id: String(v.id), name: v.name, date: v.releaseDate, open: [] });
          byVersion.get(String(v.id)).open.push({ key: i.key, status: i.fields?.status?.name || '?', who: i.fields?.assignee?.displayName || 'unassigned' });
        }
      }
      nextPageToken = res.data?.nextPageToken || null;
      if (!nextPageToken || res.data?.isLast) break;
    }
  } catch (err) {
    console.warn('[Release] released-but-unfinished lookup failed:', err.response?.status || err.message);
  }
  const out = [...byVersion.values()];
  for (let i = 0; i < out.length; i += 8) {
    await Promise.all(out.slice(i, i + 8).map(async (e) => { const c = await hasCards(e.id); e.cards = c.more ? `${c.n}+` : String(c.n); }));
  }
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));   // newest release first
}

async function versionCheck(client = null) {
  const today = isoDay(vnNow());
  const versions = await listVersions();
  const flags = { shipped: [], releasedOpen: await releasedButUnfinished(), draft: [], overdue: [], noDate: [] };
  // Released to production (per #release_production_request) but still
  // unreleased in Jira — the strongest signal, reported first
  const shippedByName = new Map();
  if (client) {
    for (const r of await shippedRequests(client)) {
      for (const n of r.names) if (!shippedByName.has(n.toLowerCase())) shippedByName.set(n.toLowerCase(), r);
    }
  }
  // Card counts run in parallel (8 at a time). UP has years of old versions
  // that were never released or archived; checking them one by one took
  // minutes. Versions dated more than STALE_DAYS ago are summarised as a
  // count instead of checked individually.
  // A version matters only if its cards moved recently. One query finds
  // every unreleased version with a card updated in the last ACTIVE_DAYS;
  // the long tail of abandoned versions becomes a single clean-up line.
  const ACTIVE_DAYS = parseInt(process.env.VERSION_CHECK_ACTIVE_DAYS || '60', 10);
  const active = new Set();
  try {
    let nextPageToken = null;
    for (let page = 0; page < 20; page++) {
      const res = await axios.get(`${JIRA_HOST}/rest/api/3/search/jql`, {
        params: { jql: `project = ${RELEASE_PROJECT} AND fixVersion in unreleasedVersions() AND updated >= -${ACTIVE_DAYS}d`,
                  maxResults: 100, fields: 'fixVersions', ...(nextPageToken ? { nextPageToken } : {}) },
        headers: headers(),
      });
      for (const i of res.data?.issues || []) for (const fv of i.fields?.fixVersions || []) active.add(String(fv.id));
      nextPageToken = res.data?.nextPageToken || null;
      if (!nextPageToken || res.data?.isLast) break;
    }
  } catch (err) {
    console.warn('[Release] active-version lookup failed:', err.response?.status || err.message);
  }
  const jobs = [];
  flags.stale = 0;
  for (const v of versions) {
    const r = shippedByName.get((v.name || '').trim().toLowerCase());
    if (r) { jobs.push({ v, kind: 'shipped', r }); continue; }
    const draft = !isRealVersionName(v.name);
    const overdue = !!v.releaseDate && v.releaseDate < today;
    const noDate = !v.releaseDate;
    if (!draft && !overdue && !noDate) continue;
    if (!active.has(String(v.id))) { flags.stale++; continue; }      // no card touched in ACTIVE_DAYS
    jobs.push({ v, kind: draft ? 'draft' : overdue ? 'overdue' : 'noDate' });
  }
  for (let i = 0; i < jobs.length; i += 8) {
    await Promise.all(jobs.slice(i, i + 8).map(async (j) => { j.c = await hasCards(j.v.id); }));
  }
  for (const j of jobs) {
    const { v, c } = j;
    const entry = { id: String(v.id), name: v.name, date: v.releaseDate || null, cards: c.more ? `${c.n}+` : String(c.n) };
    if (j.kind === 'shipped') { flags.shipped.push({ ...entry, shippedDay: j.r.day, by: j.r.by, link: j.r.link }); continue; }
    if (!c.n) continue;                                        // empty versions aren't worth anyone's time
    flags[j.kind].push(entry);
  }
  flags.overdue.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return flags;
}

function renderVersionCheck(flags) {
  const line = (e) => {
    const age = e.openDays > 0 ? ` · _open ${e.openDays} working day${e.openDays > 1 ? 's' : ''}_` : ' · _new_';
    return `• <${versionUrl(e.id)}|${esc(e.name)}> · ${e.cards} card${e.cards === '1' ? '' : 's'}${e.date ? ` · ${prettyDate(e.date)}` : ''}${age}`;
  };
  const section = (title, hint, list) => list.length
    ? `*${title}* — ${hint}\n${list.slice(0, 10).map(line).join('\n')}${list.length > 10 ? `\n_…and ${list.length - 10} more_` : ''}` : null;
  const shippedLine = (e) => {
    const age = e.openDays > 0 ? ` · _open ${e.openDays} working day${e.openDays > 1 ? 's' : ''}_` : ' · _new_';
    return `• <${versionUrl(e.id)}|${esc(e.name)}> · ${e.cards} card${e.cards === '1' ? '' : 's'} · released ${prettyDate(e.shippedDay)} by ${lib.replaceMentionsCached(`<@${e.by}>`)} (<${e.link}|request>)${age}`;
  };
  const shipped = flags.shipped?.length
    ? `*Released to production, not marked released in Jira* — from <#${PROD_RELEASE_CHANNEL}>\n${flags.shipped.slice(0, 10).map(shippedLine).join('\n')}${flags.shipped.length > 10 ? `\n_…and ${flags.shipped.length - 10} more_` : ''}`
    : null;
  const openLine = (e) => {
    const age = e.openDays > 0 ? ` · _open ${e.openDays} working day${e.openDays > 1 ? 's' : ''}_` : ' · _new_';
    const cards = e.open.slice(0, 5).map(c => `<${JIRA_HOST}/browse/${c.key}|${c.key}> ${esc(c.status)} (${esc(c.who)})`).join(', ');
    return `• <${versionUrl(e.id)}|${esc(e.name)}> · released ${prettyDate(e.date)} · ${e.open.length} of ${e.cards} card${e.cards === '1' ? '' : 's'} not done: ${cards}${e.open.length > 5 ? `, +${e.open.length - 5} more` : ''}${age}`;
  };
  const releasedOpen = flags.releasedOpen?.length
    ? `*Marked released, but not all cards are done* — finish them, or move them to the next version\n${flags.releasedOpen.slice(0, 10).map(openLine).join('\n')}${flags.releasedOpen.length > 10 ? `\n_…and ${flags.releasedOpen.length - 10} more_` : ''}`
    : null;
  const parts = [
    shipped,
    releasedOpen,
    section('Version names not in the naming format', 'a draft name, or a typo in the format — rename it to "<Platform> <number>"', flags.draft),
    section('Release date passed', 'still not marked released in Jira — release it, or move the date', flags.overdue),
    section('No release date', 'cards are assigned but the version has no date', flags.noDate),
  ].filter(Boolean);
  if (flags.stale) parts.push(`_Also ${flags.stale} old version${flags.stale > 1 ? 's' : ''} with no card activity in 2 months were never released or archived — worth archiving in Jira._`);
  return parts.join('\n\n');
}

const FIRST_SEEN = new Map();   // "<versionId>:<kind>" → ISO day first reported
// Memory resets on every restart (deploys), so "already posted today" and
// "first reported on" are read back from the bot's own posts in the review
// channel — the record that survives restarts.
async function botPostsInReview(client, days) {
  try {
    const { user_id: botUid } = await client.auth.test();
    const oldest = String((Date.now() - days * 86400 * 1000) / 1000);
    const res = await client.conversations.history({ channel: RELEASE_REVIEW_CHANNEL, oldest, limit: 200 });
    return (res.messages || []).filter(m => m.user === botUid || m.bot_id);
  } catch { return []; }
}
const vnDayOf = (ts) => isoDay(new Date(parseFloat(ts) * 1000 + 7 * 3600 * 1000));

let _firstSeenRestored = false;
async function restoreFirstSeen(client) {
  if (_firstSeenRestored) return;
  _firstSeenRestored = true;
  const posts = (await botPostsInReview(client, 21)).filter(m => /\*Fix version check\*/.test(m.text || ''))
    .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));        // oldest first
  for (const m of posts) {
    for (const x of (m.text || '').matchAll(/\/versions\/(\d+)\//g)) {
      if (!FIRST_SEEN.has(x[1])) FIRST_SEEN.set(x[1], vnDayOf(m.ts));
    }
  }
}

const checkSignature = (f) => JSON.stringify([f.draft, f.overdue, f.noDate].map(l => l.map(e => `${e.id}:${e.date}`).sort()));
let _lastCheck = { sig: null, day: null };

const DAILY_ALL_CLEAR = (process.env.VERSION_CHECK_ALL_CLEAR || 'true') !== 'false';

async function alertVersionIssues(client, { force = false, channel = RELEASE_REVIEW_CHANNEL, threadTs = null } = {}) {
  const today = isoDay(vnNow());
  await restoreFirstSeen(client);
  if (!force && _lastCheck.day !== today) {
    const already = (await botPostsInReview(client, 1)).some(m => /\*Fix version check\*/.test(m.text || '') && vnDayOf(m.ts) === today);
    if (already) { _lastCheck = { sig: null, day: today }; return; }      // posted before a restart
  }
  const flags = await versionCheck(client);
  await lib.warmUserNames(client, (flags.shipped || []).map(e => e.by)).catch(() => {});
  // Age each finding; forget ones that got fixed
  const live = new Set();
  for (const [kind, list] of Object.entries(flags)) {
    if (!Array.isArray(list)) continue;                       // e.g. the stale count
    for (const e of list) {
      const k = String(e.id);
      live.add(k);
      if (!FIRST_SEEN.has(k)) FIRST_SEEN.set(k, today);
      e.openDays = businessDaysSince(FIRST_SEEN.get(k));
    }
  }
  for (const k of [...FIRST_SEEN.keys()]) if (!live.has(k)) FIRST_SEEN.delete(k);

  const total = flags.shipped.length + flags.releasedOpen.length + flags.draft.length + flags.overdue.length + flags.noDate.length;
  if (!force && _lastCheck.day === today) return;            // once per working day
  _lastCheck = { sig: checkSignature(flags), day: today };

  if (!total) {
    if (force || DAILY_ALL_CLEAR) {
      await client.chat.postMessage({ channel, thread_ts: threadTs,
        text: `*Fix version check* (${prettyDate(today)}) — all clear: no draft names, overdue or undated versions with cards.` });
    }
    return;
  }
  const text = `${threadTs ? '' : `${notifyTags()} `}*Fix version check* (${prettyDate(today)}) — ${total} version${total > 1 ? 's need' : ' needs'} a PC's attention:\n\n${renderVersionCheck(flags)}`;
  const buttons = (flags.shipped || []).slice(0, 10).map(e => ({
    type: 'button', action_id: `rel_mark_released_${e.id}`, value: `${e.id}|${e.shippedDay}|${e.name}`.substring(0, 2000),
    text: { type: 'plain_text', text: `Mark ${e.name} released`.substring(0, 75) },
  }));
  // One block per section (Slack caps a block at 3000 chars) — never cut a line
  const blocks = [];
  for (const chunk of text.split('\n\n')) {
    let buf = '';
    for (const lineTxt of chunk.split('\n')) {
      if ((buf + '\n' + lineTxt).length > 2900 && buf) { blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf } }); buf = lineTxt; }
      else buf = buf ? `${buf}\n${lineTxt}` : lineTxt;
    }
    if (buf) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf } });
  }
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons });
  await client.chat.postMessage({ channel, thread_ts: threadTs, unfurl_links: false, unfurl_media: false, text, blocks });
}

function businessDaysSince(isoDate) {
  if (!isoDate) return Infinity;
  let n = 0;
  const d = new Date(`${isoDate}T00:00:00Z`), end = new Date(`${isoDay(vnNow())}T00:00:00Z`);
  while (d < end) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

// ── Scheduled work ───────────────────────────────────────────────────
let _reviewHeads = null;
async function draftUpcoming(client, logger = console) {
  _reviewHeads = null;
  const groups = await upcomingGroups();
  const ready = [];
  for (const g of groups) {
    if (ANNOUNCED.has(g.key) || SKIPPED.has(g.key)) continue;
    if ([...DRAFTS.values()].some(s => s.groupKey === g.key)) continue;
    if (await alreadyAnnouncedInChannel(client, g)) { ANNOUNCED.set(g.key, { ts: null, versionIds: g.versions.map(v => v.id), releaseDate: g.releaseDate, byPC: true }); continue; }
    // Already sent for review before a restart? (the review thread's head
    // message lists the versions) — don't open a second review thread
    if (!_reviewHeads) _reviewHeads = (await botPostsInReview(client, 4)).filter(m => /release.*due soon/i.test(m.text || '')).map(m => (m.text || '').toLowerCase());
    if (g.versions.every(v => _reviewHeads.some(t => t.includes(v.name.toLowerCase())))) { SKIPPED.add(g.key); continue; }
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

// Follow-ups run until things are done — not until the release date. They
// stop when every version of the announcement is marked released in Jira.
const _relCache = new Map();
async function allReleased(versionIds) {
  const ids = (versionIds || []).map(String);
  if (!ids.length) return false;
  const hit = _relCache.get(ids.join(','));
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.v;
  let v = false;
  try {
    const rs = await Promise.all(ids.map(id => axios.get(`${JIRA_HOST}/rest/api/3/version/${id}`, { headers: headers() }).then(r => !!r.data?.released)));
    v = rs.every(Boolean);
  } catch (_) {}
  _relCache.set(ids.join(','), { at: Date.now(), v });
  return v;
}

const TBD_ASKED = new Map();   // announcement ts → last 'YYYY-MM-DD hh' asked
async function remindTbd(client) {
  const today = isoDay(vnNow()), slot = `${today} ${vnNow().getUTCHours() >= 14 ? 'pm' : 'am'}`;
  for (const [, a] of ANNOUNCED) {
    if (!a.ts || a.byPC) continue;
    if (TBD_ASKED.get(a.ts) === slot) continue;
    if (await allReleased(a.versionIds)) continue;            // shipped — nothing left to chase
    TBD_ASKED.set(a.ts, slot);
    await askForTbd(client, RELEASE_CHANNEL, a.ts);          // posts only if something is still TBD
  }
}

async function postReadiness(client, logger = console) {
  const today = isoDay(vnNow());
  for (const [key, a] of ANNOUNCED) {
    if (!a.ts || a.byPC) continue;                          // only threads the bot posted
    if (a.allClear) continue;                               // already confirmed done
    if (READINESS_POSTED.get(key) === today) continue;
    if (await allReleased(a.versionIds)) continue;          // shipped — stop following
    READINESS_POSTED.set(key, today);
    const [family] = key.split('|');
    const d = await buildDraft(client, { key, family, releaseDate: a.releaseDate, versions: a.versionIds.map(id => ({ id, name: a.versionNames?.[id] || id })) });
    const isReleaseDay = a.releaseDate === today;
    const overdue = a.releaseDate && a.releaseDate < today;
    if (!d.notReady.length && !isReleaseDay && !overdue) continue;       // quiet when fully ready, until release day
    if (!d.notReady.length) a.allClear = true;               // done → one all-clear, then stop
    await client.chat.postMessage({
      channel: RELEASE_CHANNEL, thread_ts: a.ts, unfurl_links: false,
      text: d.notReady.length
        ? `${isReleaseDay ? '*Release day* — ' : overdue ? `*Past the release date (${prettyDate(a.releaseDate)})* — still not ready. ` : ''}${renderReadiness(d)}`
        : `${isReleaseDay ? '*Release day* — ' : '*All done* — '}${renderReadiness(d).replace(/^\*Readiness:\* /, '')}`,
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

let _lastDraftDay = null, _lastReadyDay = null, _lastRemindDay = null, _lastTbdPmDay = null;
function startScheduler(client) {
  setTimeout(() => recoverAnnounced(client), 20000);
  setInterval(async () => {
    try {
      const vn = vnNow(), day = isoDay(vn), dow = vn.getUTCDay(), hm = vn.getUTCHours() * 60 + vn.getUTCMinutes();
      if (dow === 0 || dow === 6) return;
      if (hm >= 9 * 60 + 30 && _lastDraftDay !== day) { _lastDraftDay = day; await draftUpcoming(client); await alertVersionIssues(client); }
      if (hm >= 10 * 60 && _lastReadyDay !== day)     { _lastReadyDay = day; await postReadiness(client); await remindTbd(client); }
      if (hm >= 14 * 60 && _lastTbdPmDay !== day)     { _lastTbdPmDay = day; await remindTbd(client); }
      if (hm >= 15 * 60 && _lastRemindDay !== day)    { _lastRemindDay = day; await remindPending(client); }
    } catch (err) {
      console.warn('[Release] scheduler error:', err.message);
    }
  }, 10 * 60 * 1000).unref?.();
}

// ── On-demand: "@QA Agent draft release for Web 4.37.1" ──────────────
// Only a short request for the report itself ("check fix versions", "run the
// version check") — never an instruction that merely mentions a fix version
// ("check if these tickets have N/A fix version then move them…").
const VERSION_CHECK_RE = /^(?:please\s+|pls\s+)?(?:check|review|audit|run)\s+(?:the\s+|all\s+)?(?:fix\s*-?\s*versions?|versions?)(?:\s+check)?\s*(?:now|please|pls)?\s*[?.!]*$|^(?:run\s+)?(?:the\s+)?(?:fix\s*)?version\s+check\s*[?.!]*$/i;
function isVersionCheckCommand(text) { return VERSION_CHECK_RE.test((text || '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '').trim()); }
const RELEASE_CMD_RE = /\b(?:draft|prepare)\s+(?:the\s+|a\s+)?(?:next\s+)?release\b|\brelease\s+(?:draft|announcement|plan)s?\b/i;
function isReleaseCommand(text) { const t = (text || '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '').trim(); return RELEASE_CMD_RE.test(t) || isVersionCheckCommand(t); }

async function handleCommand({ event, client, logger }) {
  const tTs = event.thread_ts || event.ts;
  // A live status (tracked, so a restart mid-way posts "please retry") and
  // an answer on every path — a failure must never be silent.
  const st = lib.agentStatus(client, event.channel, tTs);
  const t0 = Date.now();
  try {
    if (isVersionCheckCommand(event.text)) {
      await st.start("I'm checking the fix versions in Jira");
      await alertVersionIssues(client, { force: true, channel: event.channel, threadTs: tTs });
      await st.done();
      logger?.info?.(`[Release] version check done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }
    await st.start("I'm drafting the release from Jira");
    await handleDraftCommand({ event, client, logger, tTs });
    await st.done();
  } catch (err) {
    await st.done();
    logger?.warn?.('[Release] command failed:', err?.stack || err);
    await client.chat.postMessage({ channel: event.channel, thread_ts: tTs,
      text: `I couldn't finish that: \`${(err?.response?.status ? `Jira ${err.response.status}` : err?.message || 'unknown error').substring(0, 200)}\`` }).catch(() => {});
  }
}

async function handleDraftCommand({ event, client, logger, tTs }) {
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

// ── Re-check readiness in a release announcement thread ──────────────
// "check again", "recheck", "readiness?", "kiểm tra lại" — straight from
// Jira, no AI needed.
const RECHECK_RE = /\b(?:check|re-?check|readiness|ready|status)\b|kiểm\s*tra|xem\s*lại/i;
async function announcementVersions(client, channel, threadTs) {
  try {
    const rr = await client.conversations.replies({ channel, ts: threadTs, limit: 1 });
    const p = (rr.messages || [])[0];
    if (!p || !/Em gửi release cho/.test(p.text || '')) return null;
    const vs = [...(p.text || '').matchAll(/\/versions\/(\d+)\/tab\/release-report-all-issues\|([^>]+)>/g)].map(m => ({ id: m[1], name: m[2].replace(/&amp;/g, '&') }));
    return vs.length ? vs : null;
  } catch { return null; }
}
async function recheckThread({ event, client }) {
  const threadTs = event.thread_ts;
  if (!threadTs || !RECHECK_RE.test((event.text || '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, ''))) return false;
  const versions = await announcementVersions(client, event.channel, threadTs);
  if (!versions) return false;
  const st = lib.agentStatus(client, event.channel, threadTs);
  await st.start("I'm checking the release's cards in Jira");
  try {
    const family = versionFamily(versions[0].name);
    const d = await buildDraft(client, { key: `${family}|recheck`, family, releaseDate: null, versions });
    await st.done();
    await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, unfurl_links: false, text: renderReadiness(d) });
  } catch (err) {
    await st.done();
    await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `I couldn't check the cards in Jira: \`${(err.message || '').substring(0, 160)}\`` });
  }
  return true;
}

// ── TBD items on a release announcement ──────────────────────────────
// An announcement posted with 'Description: TBD' / 'Force/Optional Update:
// TBD' is chased by the bot — tagging the approvers in its thread with the
// controls to fill them in — instead of the PC asking by hand. Answers (or
// typed 'update description to: …') edit the announcement in place.
const TBD_FIELDS = { desc: 'Description', force: 'Set up Force/Optional Update' };
function announcementTbd(text) {
  const t = text || '';
  return Object.entries(TBD_FIELDS).filter(([, label]) => new RegExp(`•\\s*${label.replace(/[/]/g, '\\/')}:\\s*TBD\\s*$`, 'mi').test(t)).map(([k]) => k);
}
function tbdPromptBlocks(channel, ts, missing) {
  const names = missing.map(k => `*${TBD_FIELDS[k].replace('Set up ', '')}*`).join(', ');
  const text = `${RELEASE_APPROVERS.map(u => `<@${u}>`).join(' ')} still needed for this release: ${names}`;
  const meta = JSON.stringify({ c: channel, ts });
  const elements = [];
  if (missing.includes('desc')) elements.push({ type: 'button', style: 'primary', action_id: 'rel_tbd_desc', value: meta, text: { type: 'plain_text', text: 'Set description' } });
  if (missing.includes('force')) elements.push({ type: 'static_select', action_id: 'rel_tbd_force', placeholder: { type: 'plain_text', text: 'Force / Optional update' },
    options: ['Optional Update', 'Force Update', 'N/A'].map(o => ({ text: { type: 'plain_text', text: o }, value: `${o}|${meta}`.substring(0, 150) })) });
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'actions', elements }] };
}
async function askForTbd(client, channel, ts, logger = console) {
  try {
    const p = ((await client.conversations.replies({ channel, ts, limit: 1 })).messages || [])[0];
    const missing = announcementTbd(p?.text);
    if (!missing.length) return false;
    await client.chat.postMessage({ channel, thread_ts: ts, unfurl_links: false, ...tbdPromptBlocks(channel, ts, missing) });
    return true;
  } catch (err) { logger.warn?.('[Release] TBD prompt failed:', err.message); return false; }
}

// Edit one field of the bot's announcement in place
async function setAnnouncementField(client, channel, ts, key, value) {
  const p = ((await client.conversations.replies({ channel, ts, limit: 1 })).messages || [])[0];
  if (!p || !/Em gửi release cho/.test(p.text || '')) return { ok: false, reason: "that thread isn't a release announcement" };
  const { user_id: botUid } = await client.auth.test();
  if (p.user !== botUid) return { ok: false, reason: 'the announcement was posted by a person, so I can\'t edit it — update it by hand' };
  const label = TBD_FIELDS[key];
  const lines = String(value).trim().split(/\n+/).map(s => s.trim()).filter(Boolean);
  const rendered = lines.length > 1 ? `\n${lines.map(l => `    ◦ ${l}`).join('\n')}` : ` ${lines[0] || 'TBD'}`;
  const re = new RegExp(`(•\\s*${label.replace(/[/]/g, '\\/')}:)[^\\n]*((?:\\n\\s{4}◦[^\\n]*)*)`, 'i');
  if (!re.test(p.text)) return { ok: false, reason: `the announcement has no ${label} line` };
  const text = p.text.replace(re, `$1${rendered}`);
  await client.chat.update({ channel, ts, text, unfurl_links: false });
  return { ok: true, remaining: announcementTbd(text) };
}

// Typed: 'update description to: …', 'set optional update', 'force update'
async function handleAnnouncementEdit({ event, client }) {
  if (!event.thread_ts) return false;
  const raw = (event.text || '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '').trim();
  const desc = raw.match(/\b(?:update|set|change|add)\s+(?:the\s+)?description\s*(?:to|=|:)?\s*:?\s*([\s\S]+)$/i);
  const force = !desc && /\b(?:set|use|update|choose|mark|chọn)?\b[\s\S]{0,15}\b(force|optional)\s*update\b/i.exec(raw);
  if (!desc && !force) return false;
  const p = ((await client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 1 }).catch(() => ({ messages: [] }))).messages || [])[0];
  if (!p || !/Em gửi release cho/.test(p.text || '')) return false;            // not an announcement thread → not ours
  const key = desc ? 'desc' : 'force';
  const value = desc ? desc[1] : (force[1].toLowerCase() === 'force' ? 'Force Update' : 'Optional Update');
  const r = await setAnnouncementField(client, event.channel, event.thread_ts, key, value);
  await client.chat.postMessage({ channel: event.channel, thread_ts: event.thread_ts, unfurl_links: false,
    text: r.ok ? `Updated the announcement — *${TBD_FIELDS[key].replace('Set up ', '')}:* ${value.replace(/\n+/g, ' ')}${r.remaining.length ? `\nStill TBD: ${r.remaining.map(k => TBD_FIELDS[k].replace('Set up ', '')).join(', ')}` : ''}`
                : `I couldn't update it: ${r.reason}.` });
  return true;
}

// ── Confluence release pages (overview + checklist), on request ──────
// Mirrors the QA team's manual routine (everfit-release-pages): under
// 'Core Product - 2026 Release Report', an overview page with the live Jira
// table for the fix version, and a checklist page cloned from the platform's
// master checklist with QA1 / QA2 / Dev mentioned in the header. Mobile:
// one pair of pages per app version.
const CONF = {
  spaceId: process.env.CONF_SPACE_ID || '65552',                 // EV
  folderId: process.env.CONF_RELEASE_FOLDER_ID || '3685581182',  // Core Product - 2026 Release Report
  jiraCloudId: '1aa4c658-dad4-4e7e-9458-49735d9d69ca',
  datasourceId: 'd8b75300-dfda-4519-b6cd-e49abbd50401',
  templates: { Web: '532512807', API: '685047876', Android: '532611245', iOS: '532545601' },
};
const PAGES_RE = /\b(?:create|make|tạo|generate)\b[\s\S]{0,40}?\b(?:release\s+)?(?:checklists?|release\s+pages?|confluence)\b|^\s*checklist\b/i;
function isPagesCommand(text) { return PAGES_RE.test((text || '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '').trim()); }

const templateFor = (versionName) => {
  const f = versionFamily(versionName);
  if (/white label|challenger/i.test(versionName)) return null;
  return CONF.templates[f] ? { family: f, pageId: CONF.templates[f] } : null;
};
const longDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const confHeaders = () => ({ Authorization: jiraAuth(), Accept: 'application/json', 'Content-Type': 'application/json' });
const uuid = () => require('crypto').randomUUID();

// Slack ↔ Jira people
let _slackUsers = null, _slackUsersAt = 0;
async function slackIdByName(client, name) {
  if (!name) return null;
  if (!_slackUsers || Date.now() - _slackUsersAt > 3600e3) {
    _slackUsers = [];
    let cursor;
    for (let i = 0; i < 10; i++) {
      const r = await client.users.list({ limit: 200, cursor }).catch(() => null);
      if (!r) break;
      _slackUsers.push(...(r.members || []).filter(m => !m.deleted && !m.is_bot));
      cursor = r.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    _slackUsersAt = Date.now();
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const n = norm(name);
  const hit = _slackUsers.find(u => [u.real_name, u.profile?.real_name, u.profile?.display_name].some(x => norm(x) === n));
  return hit?.id || null;
}
async function jiraAccountForSlack(client, slackId) {
  try {
    const email = (await client.users.info({ user: slackId })).user?.profile?.email;
    if (!email) return null;
    const r = await axios.get(`${JIRA_HOST}/rest/api/3/user/search`, { params: { query: email }, headers: headers() });
    const u = (r.data || [])[0];
    return u ? { accountId: u.accountId, displayName: u.displayName } : null;
  } catch { return null; }
}

// Who to pre-select: the QA field on the version's cards, and its main assignee
async function suggestPeople(client, versionId) {
  const r = await axios.get(`${JIRA_HOST}/rest/api/3/search/jql`, {
    params: { jql: `fixVersion = ${versionId}`, maxResults: 100, fields: 'assignee,customfield_10131' }, headers: headers(),
  }).catch(() => ({ data: { issues: [] } }));
  const count = (vals) => Object.entries(vals.reduce((m, v) => (v ? (m[v] = (m[v] || 0) + 1, m) : m), {})).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const issues = r.data?.issues || [];
  const qas = count(issues.map(i => i.fields?.customfield_10131?.displayName));
  const devs = count(issues.map(i => i.fields?.assignee?.displayName));
  return {
    qa1: await slackIdByName(client, qas[0]), qa2: await slackIdByName(client, qas[1]),
    dev: await slackIdByName(client, devs.find(d => !qas.includes(d)) || devs[0]),
  };
}

function pagesCardBlocks(v, people, by) {
  const picker = (role, init) => ({ type: 'users_select', action_id: `relpg_${role}`, placeholder: { type: 'plain_text', text: role.toUpperCase() === 'DEV' ? 'Dev' : role.toUpperCase() },
    ...(init ? { initial_user: init } : {}) });
  const meta = JSON.stringify({ id: v.id, n: v.name, d: v.releaseDate || null, by });
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `Create the Confluence pages for *${esc(v.name)}*${v.releaseDate ? ` (${prettyDate(v.releaseDate)})` : ''}? Pick QA1, QA2 and Dev:` } },
    { type: 'actions', block_id: `relpg_people`, elements: [picker('qa1', people.qa1), picker('qa2', people.qa2), picker('dev', people.dev)] },
    { type: 'actions', elements: [
      { type: 'button', style: 'primary', action_id: 'relpg_create', value: meta.substring(0, 2000), text: { type: 'plain_text', text: 'Create pages' } },
      { type: 'button', action_id: 'relpg_cancel', value: meta.substring(0, 2000), text: { type: 'plain_text', text: 'Cancel' } },
    ] },
  ];
}

async function handlePagesCommand({ event, client }) {
  const tTs = event.thread_ts || event.ts;
  const text = (event.text || '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '');
  const all = await axios.get(`${JIRA_HOST}/rest/api/3/project/${RELEASE_PROJECT}/versions`, { headers: headers() }).then(r => r.data || []).catch(() => []);
  // 1) versions named in the message, 2) the announcement this thread belongs to
  let versions = all.filter(v => v.name && new RegExp(`(?:^|[^\\w.])${v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.])`, 'i').test(text));
  if (!versions.length && event.thread_ts) {
    const fromThread = await announcementVersions(client, event.channel, event.thread_ts);
    if (fromThread) versions = fromThread.map(fv => all.find(v => String(v.id) === String(fv.id)) || { id: fv.id, name: fv.name });
  }
  if (!versions.length) {
    // Nothing named → pick from upcoming / recent versions
    const today = isoDay(vnNow());
    const opts = all.filter(v => !v.archived && isRealVersionName(v.name) && templateFor(v.name) && (!v.released || (v.releaseDate && v.releaseDate >= isoDay(new Date(vnNow() - 14 * 864e5)))))
      .sort((a, b) => Math.abs(new Date(a.releaseDate || '2100-01-01') - new Date(today)) - Math.abs(new Date(b.releaseDate || '2100-01-01') - new Date(today))).slice(0, 25);
    await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: 'Which release?',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Which release should I create the Confluence pages for?' } },
        { type: 'actions', elements: [{ type: 'static_select', action_id: 'relpg_pick_version', placeholder: { type: 'plain_text', text: 'Pick a version' },
          options: opts.map(v => ({ text: { type: 'plain_text', text: `${v.name}${v.releaseDate ? ` · ${prettyDate(v.releaseDate)}` : ''}`.substring(0, 75) }, value: String(v.id) })) }] }] });
    return;
  }
  for (const v of versions) {
    if (!templateFor(v.name)) {
      await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: `There's no master checklist for ${v.name} (only Web, API, Android and iOS have one), so I didn't create pages for it.` });
      continue;
    }
    const people = await suggestPeople(client, v.id);
    await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: `Create the Confluence pages for ${v.name}?`, blocks: pagesCardBlocks(v, people, event.user) });
  }
}

// Create a Confluence page; a taken title gets ' (2)', ' (3)'…
async function createConfPage({ title, parentId, representation, value }) {
  for (let n = 1; n <= 6; n++) {
    const t = n === 1 ? title : `${title} (${n})`;
    try {
      const r = await axios.post(`${JIRA_HOST}/wiki/api/v2/pages`, { spaceId: CONF.spaceId, status: 'current', title: t, parentId,
        body: { representation, value } }, { headers: confHeaders() });
      return { id: r.data.id, title: t, url: `${JIRA_HOST}/wiki${r.data._links?.webui || `/spaces/EV/pages/${r.data.id}`}` };
    } catch (err) {
      const msg = JSON.stringify(err.response?.data || err.message);
      if (/title|already exists|duplicate|conflict/i.test(msg) && [400, 409].includes(err.response?.status)) continue;
      throw new Error(`Confluence ${err.response?.status || ''} ${msg.substring(0, 160)}`);
    }
  }
  throw new Error('every title variant was taken');
}

function overviewAdf(fixVersionName) {
  const jql = `fixversion = "${fixVersionName}"`;
  return { version: 1, type: 'doc', content: [
    { type: 'paragraph', attrs: { localId: uuid() } },
    { type: 'heading', attrs: { level: 2, localId: uuid() }, content: [{ type: 'text', text: 'Overview' }] },
    { type: 'heading', attrs: { level: 2, localId: uuid() }, content: [{ type: 'text', text: 'Issues in this Release' }] },
    { type: 'blockCard', attrs: { layout: 'full-width', localId: uuid(),
      url: `${JIRA_HOST}/issues/?jql=${encodeURIComponent(jql).replace(/%20/g, '+')}`,
      datasource: { id: CONF.datasourceId, parameters: { cloudId: CONF.jiraCloudId, jql },
        views: [{ type: 'table', properties: { columns: ['issuekey', 'summary', 'issuetype', 'created', 'updated', 'assignee', 'priority', 'status', 'customfield_10202', 'customfield_10131', 'key'].map(key => ({ key })) } }] } } },
    { type: 'paragraph', attrs: { localId: uuid() } },
  ] };
}

// The master checklist, with QA1 / QA2 / Dev mentioned in the header row only
async function checklistBody(templateId, people) {
  const r = await axios.get(`${JIRA_HOST}/wiki/api/v2/pages/${templateId}`, { params: { 'body-format': 'storage' }, headers: confHeaders() });
  let html = r.data?.body?.storage?.value || '';
  const mention = (acc) => acc ? ` <ac:link><ri:user ri:account-id="${acc.accountId}" /></ac:link>` : '';
  const unplaced = [];
  for (const [label, acc] of [['QA1', people.qa1], ['QA2', people.qa2], ['Dev', people.dev]]) {
    const re = new RegExp(`(<th\\b[^>]*>\\s*<p>\\s*<strong>${label}</strong>)`);
    if (acc && !re.test(html)) unplaced.push(label);
    html = html.replace(re, `$1${mention(acc)}`);
  }
  return { html, unplaced };
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
      text: `Moved ${moved.length} card(s) to ${cand.versionName}${moved.length ? `: ${moved.join(', ')}` : ''}${failed.length ? `\nCouldn't move: ${failed.join(', ')}` : ''} — by <@${body.user.id}>` }).catch(() => {});
  });

  slackApp.action(/^rel_mark_released_/, async ({ ack, body, client, logger }) => {
    await ack();
    const [versionId, day, name] = (body.actions?.[0]?.value || '').split('|');
    if (!RELEASE_APPROVERS.includes(body.user?.id)) {
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text: `Only ${RELEASE_APPROVERS.map(u => `<@${u}>`).join(' ')} can mark versions released.` }).catch(() => {});
      return;
    }
    let reply;
    try {
      await axios.put(`${JIRA_HOST}/rest/api/3/version/${versionId}`, { released: true, releaseDate: day },
        { headers: { ...headers(), 'Content-Type': 'application/json' } });
      reply = `Marked *${esc(name)}* released in Jira (release date ${prettyDate(day)}) — by <@${body.user.id}>.`;
      // Drop the button so it can't be clicked twice
      const blocks = (body.message?.blocks || []).map(b => b.type !== 'actions' ? b
        : { ...b, elements: (b.elements || []).filter(el => el.action_id !== body.actions[0].action_id) })
        .filter(b => b.type !== 'actions' || b.elements.length);
      await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: body.message.text || 'Fix version check', blocks }).catch(() => {});
    } catch (err) {
      reply = `I couldn't mark ${esc(name)} released (${err.response?.status || err.message}${err.response?.status === 403 ? ' — my Jira account needs the Manage versions permission' : ''}).`;
      logger?.warn?.('[Release] mark released failed:', err.response?.data || err.message);
    }
    await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message?.ts, text: reply }).catch(() => {});
  });

  slackApp.action('rel_redraft', async ({ ack, body, client, logger }) => {
    await ack();
    let p = {};
    try { p = JSON.parse(body.actions?.[0]?.value || '{}'); } catch (_) {}
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: `Drafting again — requested by <@${body.user?.id}>`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Drafting again — requested by <@${body.user?.id}>` } }] }).catch(() => {});
    const groups = [];
    for (const n of (p.n || [])) for (const g of await upcomingGroups({ onlyVersion: n })) if (!groups.some(x => x.key === g.key)) groups.push(g);
    for (const g of groups) await sendDraft(client, await buildDraft(client, g), { channel: p.c || body.channel.id, threadTs: p.t });
    if (!groups.length) await client.chat.postMessage({ channel: p.c || body.channel.id, thread_ts: p.t, text: "I couldn't find those versions unreleased anymore — they may have been released or renamed." }).catch(() => {});
  });

  for (const role of ['qa1', 'qa2', 'dev']) slackApp.action(`relpg_${role}`, async ({ ack }) => { await ack(); });
  slackApp.action('relpg_pick_version', async ({ ack, body, client }) => {
    await ack();
    const id = body.actions?.[0]?.selected_option?.value;
    const all = await axios.get(`${JIRA_HOST}/rest/api/3/project/${RELEASE_PROJECT}/versions`, { headers: headers() }).then(r => r.data || []).catch(() => []);
    const v = all.find(x => String(x.id) === String(id));
    if (!v) return;
    const people = await suggestPeople(client, v.id);
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: `Create the Confluence pages for ${v.name}?`, blocks: pagesCardBlocks(v, people, body.user?.id) }).catch(() => {});
  });
  slackApp.action('relpg_cancel', async ({ ack, body, client }) => {
    await ack();
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: 'Cancelled',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Cancelled by <@${body.user?.id}> — no pages created.` } }] }).catch(() => {});
  });
  slackApp.action('relpg_create', async ({ ack, body, client, logger }) => {
    await ack();
    let v = {};
    try { v = JSON.parse(body.actions?.[0]?.value || '{}'); } catch (_) {}
    const sel = body.state?.values?.relpg_people || {};
    const slack = { qa1: sel.relpg_qa1?.selected_user, qa2: sel.relpg_qa2?.selected_user, dev: sel.relpg_dev?.selected_user };
    const show = (text) => client.chat.update({ channel: body.channel.id, ts: body.message.ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }).catch(() => {});
    const missing = Object.entries(slack).filter(([, id]) => !id).map(([r]) => r.toUpperCase().replace('DEV', 'Dev'));
    if (missing.length) {
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text: `Pick ${missing.join(', ')} first.` }).catch(() => {});
      return;
    }
    await show(`Creating the Confluence pages for *${esc(v.n)}*… (requested by <@${body.user?.id}>)`);
    try {
      const tpl = templateFor(v.n);
      const people = { qa1: await jiraAccountForSlack(client, slack.qa1), qa2: await jiraAccountForSlack(client, slack.qa2), dev: await jiraAccountForSlack(client, slack.dev) };
      const date = longDate(v.d || isoDay(vnNow()));
      const overview = await createConfPage({ title: `${v.n} Release - ${date}`, parentId: CONF.folderId,
        representation: 'atlas_doc_format', value: JSON.stringify(overviewAdf(v.n)) });
      const body = await checklistBody(tpl.pageId, people);
      const checklist = await createConfPage({ title: `Checklist ${v.n} Release - ${date}`, parentId: overview.id,
        representation: 'storage', value: body.html });
      const suffix = [overview, checklist].some(p => / \(\d+\)$/.test(p.title)) ? '\n_A page with that title already existed, so I added a number — check for a duplicate._' : '';
      const noMention = Object.entries(people).filter(([, a]) => !a).map(([r]) => r.toUpperCase().replace('DEV', 'Dev'));
      await show(`Created the release pages for *${esc(v.n)}* — requested by <@${body.user?.id}>:\n` +
        `• Overview: <${overview.url}|${esc(overview.title)}>\n• Checklist: <${checklist.url}|${esc(checklist.title)}>\n` +
        `QA1 <@${slack.qa1}> · QA2 <@${slack.qa2}> · Dev <@${slack.dev}>${suffix}` +
        (noMention.length ? `\n_I couldn't find ${noMention.join(', ')} in Jira, so the checklist header doesn't mention them — add them by hand._` : '') +
        (body.unplaced.length ? `\n_The master checklist's header layout changed, so I couldn't place ${body.unplaced.join(', ')} — add the mention${body.unplaced.length > 1 ? 's' : ''} by hand._` : ''));
      logger?.info?.(`[Release] Confluence pages created for ${v.n}: ${overview.id}, ${checklist.id}`);
    } catch (err) {
      await show(`I couldn't create the pages for *${esc(v.n)}*: \`${String(err.message).substring(0, 220)}\``);
    }
  });

  const refreshTbdPrompt = async (client, body, meta, who) => {
    const p = ((await client.conversations.replies({ channel: meta.c, ts: meta.ts, limit: 1 })).messages || [])[0];
    const missing = announcementTbd(p?.text);
    const done = `All set — the announcement is complete (filled in by <@${who}>).`;
    await client.chat.update({ channel: body.channel?.id || meta.c, ts: body.message?.ts || meta.promptTs, ...(missing.length ? tbdPromptBlocks(meta.c, meta.ts, missing)
      : { text: done, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: done } }] }) }).catch(() => {});
  };
  slackApp.action('rel_tbd_force', async ({ ack, body, client }) => {
    await ack();
    const [choice, metaRaw] = (body.actions?.[0]?.selected_option?.value || '').split(/\|(.+)/);
    let meta = {}; try { meta = JSON.parse(metaRaw); } catch (_) {}
    const r = await setAnnouncementField(client, meta.c, meta.ts, 'force', choice);
    if (!r.ok) { await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text: `I couldn't update it: ${r.reason}.` }).catch(() => {}); return; }
    await refreshTbdPrompt(client, body, meta, body.user.id);
  });
  slackApp.action('rel_tbd_desc', async ({ ack, body, client }) => {
    await ack();
    let meta = {}; try { meta = JSON.parse(body.actions?.[0]?.value || '{}'); } catch (_) {}
    await client.views.open({ trigger_id: body.trigger_id, view: {
      type: 'modal', callback_id: 'rel_tbd_desc_submit', private_metadata: JSON.stringify({ ...meta, promptTs: body.message?.ts, promptCh: body.channel?.id }),
      title: { type: 'plain_text', text: 'Release description' }, submit: { type: 'plain_text', text: 'Save' },
      blocks: [{ type: 'input', block_id: 'd', label: { type: 'plain_text', text: 'Store description (one line per point)' },
        element: { type: 'plain_text_input', action_id: 'v', multiline: true, placeholder: { type: 'plain_text', text: 'Community Forum updates.\nOther fixes and improvements.' } } }] } }).catch(() => {});
  });
  slackApp.view('rel_tbd_desc_submit', async ({ ack, view, body, client }) => {
    await ack();
    let meta = {}; try { meta = JSON.parse(view.private_metadata || '{}'); } catch (_) {}
    const value = view.state?.values?.d?.v?.value || '';
    const r = await setAnnouncementField(client, meta.c, meta.ts, 'desc', value);
    if (!r.ok) { await client.chat.postMessage({ channel: meta.c, thread_ts: meta.ts, text: `I couldn't update the description: ${r.reason}.` }).catch(() => {}); return; }
    await refreshTbdPrompt(client, { channel: { id: meta.promptCh }, message: { ts: meta.promptTs } }, meta, body.user.id);
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
      // Expired (restart): redraft it with one click, from the versions in the draft
      const names = [...new Set([...(JSON.stringify(body.message?.blocks || []).matchAll(/versions\/\d+\/tab\/release-report-all-issues\|([^>]+)>/g))].map(m => m[1]))];
      await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message.thread_ts || body.message.ts,
        text: "That draft expired (I restarted), so I didn't post it.",
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: "That draft expired (I restarted), so I didn't post it." } },
          { type: 'actions', elements: [{ type: 'button', style: 'primary', action_id: 'rel_redraft', text: { type: 'plain_text', text: 'Draft again' },
            value: JSON.stringify({ n: names.slice(0, 4), c: body.channel.id, t: body.message.thread_ts || body.message.ts }).substring(0, 2000) }] }] }).catch(() => {});
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
    await askForTbd(client, RELEASE_CHANNEL, posted.ts, logger);
    await client.chat.update({ channel: st.channel, ts: st.ts, text: 'Posted',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Approved by <@${body.user.id}> and posted the ${fresh.group.family} release to <#${RELEASE_CHANNEL}> — <${link}|view>. I'll post readiness in its thread each morning until release day.` } }] }).catch(() => {});
    logger?.info?.(`[Release] Approved and posted ${st.groupKey}`);
  });
}

module.exports = {
  __test_recover: (client) => recoverAnnounced(client),
  __test_tick: async (client) => { await postReadiness(client); await remindTbd(client); },
  register, startScheduler, isReleaseCommand, handleCommand, recheckThread, isPagesCommand, handlePagesCommand, handleAnnouncementEdit, askForTbd, announcementTbd, setAnnouncementField,
  // exported for tests
  versionFamily, upcomingWorkdays, itemLabel, renderAnnouncement, renderReadiness, buildDraft, upcomingGroups,
  versionTagRegex, findCandidates, moveToVersion, PLACEHOLDER_VERSION_IDS, draftUpcoming, remindPending,
  isRealVersionName, versionCheck, renderVersionCheck, alertVersionIssues, requestToVersionNames, shippedRequests,
};
