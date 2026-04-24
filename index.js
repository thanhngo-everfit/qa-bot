require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

const slackApp = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Team map: Slack user ID → platform they own ─
// Populate via env var TEAM_MAP_JSON, e.g.
//   TEAM_MAP_JSON='{"U01LAMBUI":"Android Client","U02TUANNG":"iOS Coach","U03HUNGVO":"Web","U04BENGUYEN":"API"}'
// Used as a strong hint when the QA assigns a bug to a specific dev —
// the bot will prefer that dev's team platform for client-side bugs.
let TEAM_MAP = {};
try {
  TEAM_MAP = JSON.parse(process.env.TEAM_MAP_JSON || '{}');
  console.log(`[QABot] Loaded TEAM_MAP with ${Object.keys(TEAM_MAP).length} entries`);
} catch (err) {
  console.warn('[QABot] TEAM_MAP_JSON invalid, ignoring:', err.message);
}

function getTeamForSlackUser(slackUserId) {
  return TEAM_MAP[slackUserId] || null;
}

function jiraAuth() {
  return 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
}

async function resolveJiraAccountId(slackClient, slackUserId) {
  try {
    const info  = await slackClient.users.info({ user: slackUserId });
    const email = info.user?.profile?.email;
    if (!email) return null;
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/user/search`, {
      params:  { query: email, maxResults: 1 },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return res.data?.[0]?.accountId ?? null;
  } catch { return null; }
}

function buildSlackThreadUrl(channelId, threadTs) {
  const ts = threadTs.replace('.', '');
  return `https://everfit.slack.com/archives/${channelId}/p${ts}`;
}

// ── Pull out any curl commands from the thread ──
// Grabs: (a) fenced code blocks starting with `curl`
//        (b) inline `curl ...` lines with backslash-continued lines joined
// Slack adds smart quotes sometimes — normalize them so the command is runnable.
function extractCurlCommands(text) {
  if (!text) return [];
  const curls = [];
  const seen = new Set();
  const norm = s => s
    .replace(/[\u2018\u2019]/g, "'")     // curly single → straight
    .replace(/[\u201C\u201D]/g, '"')     // curly double → straight
    .trim();
  const push = c => {
    const n = norm(c);
    if (n && !seen.has(n.slice(0, 80))) { seen.add(n.slice(0, 80)); curls.push(n); }
  };

  // (a) fenced blocks
  const fence = /```([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text)) !== null) {
    const body = m[1].replace(/^\w+\n/, '').trim(); // drop any language tag
    if (/^\s*curl\b/i.test(body)) push(body);
  }

  // (b) inline curls (ignore anything already inside fences)
  const stripped = text.replace(fence, '');
  const inline = /(?:^|\n)[ \t>]*(curl\b[^\n]*(?:\\\s*\n[^\n]*)*)/gi;
  while ((m = inline.exec(stripped)) !== null) {
    push(m[1].replace(/\\\s*\n\s*/g, ' '));
  }
  return curls;
}

async function getThread(client, channelId, threadTs) {  const result   = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
  const messages = result.messages || [];
  const lines    = await Promise.all(messages.map(async msg => {
    let name = msg.username || msg.user || 'user';
    try {
      const info = await client.users.info({ user: msg.user });
      name = info.user?.real_name || name;
    } catch (_) {}
    const text = (msg.text || '').replace(/<@([A-Z0-9]+)>/g, (_, uid) => `@${uid}`);
    return `[${name}]: ${text}`;
  }));
  return lines.join('\n');
}

// ── Collect attachments from ALL messages in a thread ──
async function getAllThreadAttachments(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    const messages = result.messages || [];
    const attachments = [];
    for (const msg of messages) {
      // Skip bot messages — don't re-upload bot's own posts
      if (msg.bot_id) continue;
      const files = msg.files || [];
      for (const f of files) {
        if (!f.url_private_download) continue;
        attachments.push({
          name:     f.name || f.title || 'attachment',
          url:      f.url_private_download,
          mimetype: f.mimetype || 'application/octet-stream',
          size:     f.size || 0,
        });
      }
    }
    console.log(`[QABot] Thread has ${attachments.length} attachment(s) total`);
    return attachments;
  } catch (err) {
    console.warn('[QABot] Could not get attachments:', err.message);
    return [];
  }
}

async function downloadSlackFile(url) {
  const res = await axios.get(url, {
    headers:      { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: 'arraybuffer',
    timeout:      120000,   // 2 minutes — screen recordings can be large
    maxContentLength: 100 * 1024 * 1024,  // 100MB max
    maxBodyLength:    100 * 1024 * 1024,
  });
  return Buffer.from(res.data);
}

async function uploadAttachmentToJira(issueKey, filename, fileBuffer, mimetype) {
  try {
    const form = new FormData();
    form.append('file', fileBuffer, { filename, contentType: mimetype });
    await axios.post(
      `${JIRA_HOST}/rest/api/3/issue/${issueKey}/attachments`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization:       jiraAuth(),
          'X-Atlassian-Token': 'no-check',
        },
        timeout:          120000,
        maxContentLength: 100 * 1024 * 1024,
        maxBodyLength:    100 * 1024 * 1024,
      }
    );
    return true;
  } catch (err) {
    console.warn(`[QABot] Failed to upload ${filename}:`, err.message);
    return false;
  }
}

// ── Fetch latest unreleased fix version ──────
async function getLatestFixVersionId() {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/project/${JIRA_PROJECT}/versions`, {
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const versions = (res.data || []).filter(v => !v.archived && !v.released);
    if (versions.length === 0) return null;
    versions.sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));
    return versions[versions.length - 1].id;
  } catch { return null; }
}

// ── Parse QA bug with Claude (robust) ────────
async function parseBugReport(threadContext, triggerText, assigneeTeamHints) {
  const teamHint = Array.isArray(assigneeTeamHints) && assigneeTeamHints.length > 0
    ? `\n\nASSIGNEE TEAM HINT (the QA tagged devs from these teams — strong signal for client-side bugs): ${assigneeTeamHints.join(', ')}`
    : '';

  const res = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    system: `You are QABot for Everfit. Your job: parse a QA bug report from a Slack thread and decide the CORRECT platform based on root cause — not just where the bug was seen.

INPUTS YOU RECEIVE:
- TRIGGER MESSAGE: the message that mentioned the bot. Often contains assignment/team hints like "nhờ @X team mobile check", "@BE coi với", "assign to @Y".
- THREAD: the full Slack thread. The FIRST message is the QA's bug report. Later messages are discussion/commands — use them for context (platform hints, team mentions, additional details) but do NOT treat them as the bug itself.
- ASSIGNEE TEAM HINT (optional): the teams the tagged devs belong to. Trust this for client-side bugs.

WHAT TO IGNORE:
- Bot messages ([qa-bot], [bug-reporting-tracker])
- Command-only messages ("@qa-bot log this", "@bug-reporting-tracker ...")
- Boilerplate like "Nhờ team check giúp"
- @mentions and subteam IDs in the summary — the summary must be clean English bug description.

====================================================================
PLATFORM DECISION — follow in order, stop at first match:
====================================================================

STEP 1 — ROOT CAUSE ANALYSIS (most important):
Decide whether the bug lives in the BACKEND or a CLIENT, regardless of who reported it or where they saw it.

Signals the bug is BACKEND → platform = "API":
- API/endpoint returns wrong data, 4xx/5xx, timeouts
- Data not saving, sync failure, data inconsistency between clients
- Auth/token/session issues
- Calculation happens server-side and value is wrong (e.g., wrong calorie total, wrong progress %)
- Same bug visible on multiple clients
- Reporter pastes a curl / request / response payload as evidence
- Reporter is from BE team, or message says "BE check", "API trả sai", "server returns…"
- Webhook / push notification / email delivery issue
- Permissions/ACL issue

If ANY of these apply → platform is "API". Do NOT use iOS/Android/Web even if the Android dev reported it or it was seen on the Android app. The root cause is backend.

STEP 2 — CLIENT-SIDE BUG: pick the client platform.
Only reach this step if the bug is clearly a UI/UX/rendering/interaction issue on one specific client.

Priority order for picking the client:
  2a. Explicit mention in the bug text: "trên iOS", "on Android", "Web dashboard", "coach app iOS", "client app Android", "UI của web", etc.
  2b. ASSIGNEE TEAM HINT (if provided). If QA assigned the bug to a mobile dev, it's a mobile bug. If to a web dev, it's Web.
  2c. Explicit team mention in trigger: "team mobile" → iOS/Android Client (default iOS Client unless Android is more specific), "team web" → Web.
  2d. Default: "Web".

Within mobile:
  - Coach-facing features (assign workout, client list, programs, coach dashboard) → iOS Coach / Android Coach
  - Client-facing features (log workout, meal plan, progress photos, macros, metrics the client sees) → iOS Client / Android Client

Valid platforms (one of): Web, API, iOS Client, iOS Coach, Android Client, Android Coach

====================================================================
OUTPUT — valid JSON only, NO fences, NO explanation:
====================================================================
{
  "summary": "[Platform][Feature] Clear English bug description under 80 chars. No @mentions, no usernames, no 'Nhờ team check'.",
  "priority": "Highest" | "High" | "Medium" | "Low" | "Lowest",
  "platform": "Web" | "API" | "iOS Client" | "iOS Coach" | "Android Client" | "Android Coach",
  "root_cause_reasoning": "One short sentence explaining WHY you picked this platform. E.g. 'Reporter is on Android team but the bug is about wrong calorie total returned by the server — backend calculation issue, so API.'",
  "description": "Clean multi-section text using real \\n newlines:\\n\\nSteps to reproduce:\\n1. ...\\n2. ...\\n\\nExpected behavior:\\n- ...\\n\\nActual behavior:\\n- ...\\n\\nEnvironment:\\n- <browser, device, OS, app version, or N/A>\\n\\nNote: <test account, PROD/STG, extra context, or N/A>",
  "assignee_names": ["Full Name of the person the QA tagged to fix. Look for '@X check', 'nhờ @X', '@X fix', '@X coi với'. Empty array if nobody."]
}

====================================================================
PRIORITY RUBRIC (unchanged):
====================================================================
"Highest" — Blocker: app down, crash on launch, data loss, payment failure, auth bypass, can't log in at all
"High" — Major: core feature fully broken for many users, crash on common action, PROD-only affecting active users, sync failure blocking usage
"Medium" — Normal: feature partially broken w/ workaround, confusing UX, limited users, typos, UI hiding critical info
"Low" — Minor: spacing/padding/alignment/color on client UI (still understandable), UI flicker, edge-case bugs, nice-to-haves
"Lowest" — Trivial: internal-only cosmetic issues, non-blocking suggestions

NEVER return null/undefined/empty. Always make a reasonable decision.`,
    messages: [{
      role: 'user',
      content:
`TRIGGER MESSAGE (this mentioned the bot — contains team/assignment hints):
${triggerText || '(none)'}${teamHint}

THREAD:
${threadContext}`
    }],
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }

  // Defensive defaults — never undefined
  return {
    summary:        parsed.summary        || `[Web][Bug] Bug report from QA`,
    priority:       parsed.priority       || 'Medium',
    platform:       parsed.platform       || 'Web',
    root_cause_reasoning: parsed.root_cause_reasoning || '',
    description:    parsed.description    || 'Description not parsed. Please update manually.',
    assignee_names: Array.isArray(parsed.assignee_names) ? parsed.assignee_names : [],
  };
}

function lineToAdfContent(line) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = []; let last = 0, match;
  while ((match = urlRegex.exec(line)) !== null) {
    if (match.index > last) parts.push({ type: 'text', text: line.slice(last, match.index) });
    parts.push({ type: 'text', text: match[1], marks: [{ type: 'link', attrs: { href: match[1] } }] });
    last = match.index + match[1].length;
  }
  if (last < line.length) parts.push({ type: 'text', text: line.slice(last) });
  return parts.length > 0 ? parts : [{ type: 'text', text: line }];
}

function buildAdfDescription(text, curlCommands) {
  const lines = (text || '').split('\n');
  const content = [];
  for (const line of lines) {
    if (line.trim() === '') content.push({ type: 'paragraph', content: [] });
    else content.push({ type: 'paragraph', content: lineToAdfContent(line) });
  }
  if (Array.isArray(curlCommands) && curlCommands.length > 0) {
    content.push({ type: 'paragraph', content: [] });
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Reproduction (curl)' }],
    });
    for (const cmd of curlCommands) {
      content.push({
        type: 'codeBlock',
        attrs: { language: 'bash' },
        content: [{ type: 'text', text: cmd }],
      });
    }
  }
  return { type: 'doc', version: 1, content };
}

async function createJiraIssue(ticket, jiraAccountIds, epicKey, fixVersionId, parentKey, reporterJiraId, curlCommands) {
  const fields = {
    project:     { key: JIRA_PROJECT },
    summary:     ticket.summary,
    issuetype:   { name: 'Bug' },
    priority:    { name: ticket.priority },
    description: buildAdfDescription(ticket.description, curlCommands),
  };

  // Parent from channel canvas (if found)
  if (parentKey) fields.parent = { key: parentKey };
  if (epicKey) fields['customfield_10014'] = epicKey;
  if (fixVersionId) fields.fixVersions = [{ id: fixVersionId }];
  if (jiraAccountIds.length > 0) fields.assignee = { accountId: jiraAccountIds[0] };

  // Reporter — safe to set at creation (standard Jira field)
  if (reporterJiraId) fields.reporter = { accountId: reporterJiraId };

  const res = await axios.post(`${JIRA_HOST}/rest/api/3/issue`, { fields }, {
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  const issueKey = res.data.key;

  // QA field — set via update because it may not be on the Create screen for UP project
  if (reporterJiraId) {
    try {
      await axios.put(
        `${JIRA_HOST}/rest/api/3/issue/${issueKey}`,
        { fields: { customfield_10074: { accountId: reporterJiraId } } },
        { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
      );
    } catch (err) {
      console.warn(`[QABot] Could not set QA field on ${issueKey}: ${err.response?.data?.errors?.customfield_10074 || err.message}`);
    }
  }

  return { key: issueKey, url: `${JIRA_HOST}/browse/${issueKey}` };
}

// ── Fetch Jira issue title ────────────────────
async function getJiraIssueTitle(issueKey) {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/issue/${issueKey}?fields=summary`, {
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return res.data?.fields?.summary || null;
  } catch { return null; }
}

// ── Resolve a PI (PLAN-XXX) to its linked Epics ──
// Returns array of { key, title } for every linked Epic/UP-ticket
async function getLinkedEpicsFromPI(planKey) {
  try {
    const res = await axios.get(
      `${JIRA_HOST}/rest/api/3/issue/${planKey}?fields=issuelinks,summary`,
      { headers: { Authorization: jiraAuth(), Accept: 'application/json' } }
    );
    const links = res.data?.fields?.issuelinks || [];
    const epics = [];
    for (const l of links) {
      const target = l.outwardIssue || l.inwardIssue;
      if (!target) continue;
      // Only collect UP-XXXXX keys (actual Epics/tickets in our project)
      if (!target.key?.startsWith('UP-')) continue;
      epics.push({ key: target.key, title: target.fields?.summary || null });
    }
    console.log(`[QABot] PI ${planKey} → linked epics: ${epics.map(e => e.key).join(', ') || 'none'}`);
    return epics;
  } catch (err) {
    console.warn(`[QABot] Could not fetch PI ${planKey}:`, err.message);
    return [];
  }
}

// ── Read channel canvas content ───────────────
async function getChannelCanvasContent(client, channelId) {
  try {
    let canvasFileId = null;

    // Method 1: channel properties (primary channel canvas)
    try {
      const chan = await client.conversations.info({ channel: channelId });
      canvasFileId = chan.channel?.properties?.canvas?.file_id;
      if (canvasFileId) console.log(`[QABot] Canvas via channel.properties: ${canvasFileId}`);
    } catch (e) { console.log(`[QABot] conversations.info failed: ${e.message}`); }

    // Method 2: bookmarks — canvas bookmark links contain the file ID
    if (!canvasFileId) {
      try {
        const bookmarks = await client.bookmarks.list({ channel_id: channelId });
        for (const b of (bookmarks.bookmarks || [])) {
          // Canvas bookmarks have link like https://everfit.slack.com/docs/TXXX/FXXX
          const m = (b.link || '').match(/\/docs\/[A-Z0-9]+\/(F[A-Z0-9]+)/i);
          if (m) { canvasFileId = m[1]; console.log(`[QABot] Canvas via bookmarks: ${canvasFileId}`); break; }
        }
      } catch (e) { console.log(`[QABot] bookmarks.list failed: ${e.message}`); }
    }

    // Method 3: files.list scoped to channel, look for a file of type 'quip' or 'canvas'
    if (!canvasFileId) {
      try {
        const files = await client.files.list({ channel: channelId, types: 'canvases', count: 5 });
        const canvasFile = (files.files || []).find(f => f.filetype === 'quip' || f.filetype === 'canvas');
        if (canvasFile) { canvasFileId = canvasFile.id; console.log(`[QABot] Canvas via files.list: ${canvasFileId}`); }
      } catch (e) { console.log(`[QABot] files.list failed: ${e.message}`); }
    }

    if (!canvasFileId) {
      console.warn('[QABot] No canvas found for channel ' + channelId);
      return null;
    }

    // Fetch canvas content — Slack canvases use this endpoint
    const fileInfo = await client.files.info({ file: canvasFileId });
    const url = fileInfo.file?.url_private || fileInfo.file?.url_private_download;

    if (!url) {
      console.warn('[QABot] Canvas file has no url_private');
      return null;
    }

    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      responseType: 'text',
    });
    const content = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    console.log(`[QABot] Canvas content length: ${content.length}, sample: ${content.substring(0, 200)}`);
    return content;
  } catch (err) {
    console.warn('[QABot] Could not read canvas:', err.message);
    return null;
  }
}

// ── Pick parent from canvas based on bug platform ──
async function pickParentFromCanvas(client, channelId, bugPlatform) {
  const canvasContent = await getChannelCanvasContent(client, channelId);
  if (!canvasContent) return null;

  // Extract all UP- and PLAN- keys from canvas
  const upKeys   = [...new Set((canvasContent.match(/UP-\d+/g)   || []))];
  const planKeys = [...new Set((canvasContent.match(/PLAN-\d+/g) || []))];
  console.log(`[QABot] Canvas keys: UP=${upKeys.join(',')} PLAN=${planKeys.join(',')}`);

  // Build candidate list: direct UP tickets + Epics linked from PIs
  const candidates = [];

  // Direct UP keys from canvas
  for (const key of upKeys) {
    const title = await getJiraIssueTitle(key);
    if (title) candidates.push({ key, title });
  }

  // Expand each PI to its linked Epics
  for (const plan of planKeys) {
    const linked = await getLinkedEpicsFromPI(plan);
    for (const e of linked) {
      if (!candidates.find(c => c.key === e.key)) {
        // Fetch title if missing
        const title = e.title || await getJiraIssueTitle(e.key);
        if (title) candidates.push({ key: e.key, title });
      }
    }
  }

  if (candidates.length === 0) {
    console.log('[QABot] No candidate parents found');
    return null;
  }

  console.log(`[QABot] Candidates: ${candidates.map(c => `${c.key}="${c.title}"`).join(' | ')}`);

  // Match a title against a platform prefix (iOS -, iOS |, iOS-, iOS|)
  const matchPrefix = prefix => candidates.find(p => {
    const lower = p.title.toLowerCase().trim();
    const pf    = prefix.toLowerCase();
    return lower.startsWith(pf + ' -')
        || lower.startsWith(pf + '-')
        || lower.startsWith(pf + ' |')
        || lower.startsWith(pf + '|');
  });

  // Priority: exact match → Mobile (for iOS/Android) → All Platforms
  let priorities;
  switch (bugPlatform) {
    case 'iOS Client':
    case 'iOS Coach':
      priorities = ['iOS', 'Mobile', 'All Platforms'];
      break;
    case 'Android Client':
    case 'Android Coach':
      priorities = ['Android', 'Mobile', 'All Platforms'];
      break;
    case 'Web':
      priorities = ['Web', 'All Platforms'];
      break;
    case 'API':
      priorities = ['API', 'All Platforms'];
      break;
    case 'CMS':
      priorities = ['CMS', 'All Platforms'];
      break;
    default:
      priorities = ['All Platforms'];
  }

  for (const prefix of priorities) {
    const match = matchPrefix(prefix);
    if (match) {
      console.log(`[QABot] Parent matched: ${match.key} "${match.title}" via prefix "${prefix}"`);
      return match.key;
    }
  }
  console.log(`[QABot] No parent found for platform=${bugPlatform}`);
  return null;
}

async function getActiveSprintId() {
  try {
    const boardRes = await axios.get(`${JIRA_HOST}/rest/agile/1.0/board`, {
      params: { projectKeyOrId: JIRA_PROJECT, type: 'scrum' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const board = boardRes.data?.values?.[0];
    if (!board) { console.warn('[QABot] No scrum board found for project', JIRA_PROJECT); return null; }
    const sprintRes = await axios.get(`${JIRA_HOST}/rest/agile/1.0/board/${board.id}/sprint`, {
      params: { state: 'active' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const sprint = sprintRes.data?.values?.[0];
    if (!sprint) { console.warn(`[QABot] No active sprint on board ${board.id}`); return null; }
    console.log(`[QABot] Active sprint: ${sprint.id} "${sprint.name}"`);
    return sprint.id;
  } catch (err) {
    console.warn('[QABot] getActiveSprintId failed:', err.response?.data ?? err.message);
    return null;
  }
}

async function addIssueToSprint(issueKey, sprintId) {
  try {
    await axios.post(`${JIRA_HOST}/rest/agile/1.0/sprint/${sprintId}/issue`,
      { issues: [issueKey] },
      { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
  } catch (err) {
    console.warn(`[QABot] Could not add ${issueKey} to sprint ${sprintId}:`, err.response?.data ?? err.message);
  }
}

async function findSlackUserByName(client, name) {
  try {
    const res   = await client.users.list({ limit: 200 });
    const lower = name.toLowerCase();
    const match = (res.members || []).find(u =>
      (u.real_name || '').toLowerCase().includes(lower) ||
      (u.profile?.display_name || '').toLowerCase().includes(lower) ||
      (u.name || '').toLowerCase().includes(lower)
    );
    return match?.id ?? null;
  } catch { return null; }
}

// ── Read channel canvas and extract parent Jira key ──
async function getParentFromChannelCanvas(client, channelId) {
  try {
    // Get channel info to find the canvas file_id
    const info = await client.conversations.info({ channel: channelId });
    const canvasFileId = info.channel?.properties?.canvas?.file_id;
    if (!canvasFileId) {
      console.warn('[QABot] No canvas found on channel', channelId);
      return null;
    }

    // Get the canvas file metadata
    const fileInfo = await client.files.info({ file: canvasFileId });
    const downloadUrl = fileInfo.file?.url_private_download || fileInfo.file?.url_private;
    if (!downloadUrl) {
      console.warn('[QABot] Canvas file has no download URL');
      return null;
    }

    // Download canvas content with bot token
    const res = await axios.get(downloadUrl, {
      headers:      { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      responseType: 'text',
      transformResponse: [d => d], // keep raw
    });
    const content = String(res.data || '');

    // Match Jira URL pattern or UP-XXXXX key in the canvas
    const urlMatch = content.match(/everfit\.atlassian\.net\/browse\/(UP-\d+)/i);
    if (urlMatch) return urlMatch[1].toUpperCase();

    const keyMatch = content.match(/\b(UP-\d+)\b/i);
    if (keyMatch) return keyMatch[1].toUpperCase();

    return null;
  } catch (err) {
    console.warn('[QABot] Could not read channel canvas:', err.message);
    return null;
  }
}

slackApp.event('app_mention', async ({ event, client, logger }) => {
  const botUserId = (await client.auth.test()).user_id;
  const threadTs  = event.thread_ts || event.ts;

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  try {
    let context;
    if (event.thread_ts) {
      context = await getThread(client, event.channel, event.thread_ts);
    } else {
      context = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    }

    if (!context || context.trim().length < 10) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: '👋 Tag me *inside a QA bug thread* — I\'ll log the bug to Jira automatically!',
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Detect explicit @mentions in the trigger message FIRST ──
    // This lets us feed team info into the parser so platform detection
    // can use "assignee is on mobile team" as a signal.
    const triggerMentions = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
      .map(m => m.replace(/<@|>/g, ''))
      .filter(id => id !== botUserId);

    // Look up each mentioned Slack user's team from TEAM_MAP
    const assigneeTeamHints = triggerMentions
      .map(id => getTeamForSlackUser(id))
      .filter(Boolean);
    if (assigneeTeamHints.length > 0) {
      logger.info(`[QABot] Team hints from trigger: ${assigneeTeamHints.join(', ')}`);
    }

    // Extract any curl commands from the whole thread for the description
    const curlCommands = extractCurlCommands(context);
    if (curlCommands.length > 0) {
      logger.info(`[QABot] Found ${curlCommands.length} curl command(s) in thread`);
    }

    const ticket = await parseBugReport(context, event.text, assigneeTeamHints);
    logger.info(`[QABot] Parsed: ${ticket.summary} [${ticket.priority}] platform=${ticket.platform}`);
    if (ticket.root_cause_reasoning) {
      logger.info(`[QABot] Root cause: ${ticket.root_cause_reasoning}`);
    }

    // Finalize assignee list (trigger mentions win; else fall back to names the AI extracted)
    let assigneeSlackIds = triggerMentions;
    if (assigneeSlackIds.length === 0 && ticket.assignee_names.length > 0) {
      for (const name of ticket.assignee_names) {
        const id = await findSlackUserByName(client, name);
        if (id) assigneeSlackIds.push(id);
      }
    }

    const jiraIds = (
      await Promise.all(assigneeSlackIds.map(id => resolveJiraAccountId(client, id)))
    ).filter(Boolean);

    // Parse Epic from trigger message (PLAN-XXX or UP-XXX)
    const epicMatch = event.text.match(/\b(PLAN-\d+|UP-\d+)\b/i);
    const epicKey   = epicMatch ? epicMatch[0].toUpperCase() : null;

    // Hardcoded fix version = "To be confirmed" (ID 12023)
    const fixVersionId = '12023';

    // Read parent from channel canvas (matched by bug platform)
    const parentKey = await pickParentFromCanvas(client, event.channel, ticket.platform);
    logger.info(`[QABot] Parent from canvas: ${parentKey || 'none'}`);

    // Resolve triggering user's Jira ID for Reporter + QA field
    const reporterJiraId = await resolveJiraAccountId(client, event.user);
    logger.info(`[QABot] Reporter/QA set to: ${event.user} → Jira ${reporterJiraId || 'not found'}`);

    // Prepend Slack thread URL to description
    const slackThreadUrl = buildSlackThreadUrl(event.channel, threadTs);
    ticket.description = `Slack thread: ${slackThreadUrl}\n\n${ticket.description}`;

    const attachments = await getAllThreadAttachments(client, event.channel, threadTs);
    logger.info(`[QABot] Creating: epic=${epicKey || 'none'} fixVersion=${fixVersionId || 'none'} parent=${parentKey || 'none'} attachments=${attachments.length} curls=${curlCommands.length}`);

    const jira = await createJiraIssue(ticket, jiraIds, epicKey, fixVersionId, parentKey, reporterJiraId, curlCommands);

    // Always use the currently active (open) sprint on the board
    const sprintId = await getActiveSprintId();
    if (sprintId) {
      logger.info(`[QABot] Adding ${jira.key} to active sprint ${sprintId}`);
      await addIssueToSprint(jira.key, sprintId);
    } else {
      logger.warn(`[QABot] No active sprint found — ${jira.key} will stay in backlog`);
    }

    // Upload attachments with per-file logging
    let uploaded = 0;
    for (const att of attachments) {
      const sizeMB = (att.size / 1024 / 1024).toFixed(1);
      logger.info(`[QABot] Downloading ${att.name} (${sizeMB}MB)...`);
      try {
        const buf = await downloadSlackFile(att.url);
        logger.info(`[QABot] Uploading ${att.name} to ${jira.key}...`);
        const ok  = await uploadAttachmentToJira(jira.key, att.name, buf, att.mimetype);
        if (ok) { uploaded++; logger.info(`[QABot] ✓ ${att.name}`); }
        else     { logger.warn(`[QABot] ✗ ${att.name} failed to upload`); }
      } catch (err) {
        logger.warn(`[QABot] ✗ ${att.name}: ${err.message}`);
      }
    }
    logger.info(`[QABot] Uploaded ${uploaded}/${attachments.length} attachments to ${jira.key}`);

    const assigneeLine = assigneeSlackIds.length > 0
      ? `Assigned to ${assigneeSlackIds.map(id => `<@${id}>`).join(', ')}`
      : '_No assignee — please assign in Jira_';

    const parentLine = parentKey ? `\nParent: <${JIRA_HOST}/browse/${parentKey}|${parentKey}>` : '';
    const epicLine   = epicKey ? `\nEpic: <${JIRA_HOST}/browse/${epicKey}|${epicKey}>` : '';
    const attachLine = uploaded > 0 ? `\n📎 ${uploaded} attachment${uploaded > 1 ? 's' : ''} uploaded` : '';

    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text:
        `🐛 *Bug logged!* → <${jira.url}|${jira.key}>\n` +
        `*${ticket.summary}*\n` +
        `Priority: *${ticket.priority}* · Platform: *${ticket.platform}*\n` +
        `${assigneeLine}${parentLine}${epicLine}${attachLine}`,
    });

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});

  } catch (err) {
    const jiraErrors = err.response?.data?.errors;
    const jiraMessages = err.response?.data?.errorMessages;
    const errDetail = jiraErrors
      ? Object.entries(jiraErrors).map(([f, m]) => `${f}: ${m}`).join(', ')
      : (jiraMessages || []).join(', ') || err.message;
    logger.error('[QABot]', err.response?.data ?? err.message);
    await client.chat.postMessage({
      channel: event.channel, thread_ts: event.thread_ts || event.ts,
      text: `❌ QABot error: \`${errDetail}\``,
    });
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
  }
});

(async () => {
  await slackApp.start(process.env.PORT || 3001);
  console.log('✅ QABot running on port', process.env.PORT || 3001);
})();
