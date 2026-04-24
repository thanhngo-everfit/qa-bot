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

// ── Spreadsheet helpers (CSV / XLSX / XLS → rows → AI text) ──

// Detect if a Slack file attachment is a spreadsheet we can read.
function isSpreadsheetAttachment(file) {
  const name = (file.name || '').toLowerCase();
  const mt   = (file.mimetype || '').toLowerCase();
  return name.endsWith('.csv')
      || name.endsWith('.xlsx')
      || name.endsWith('.xls')
      || name.endsWith('.tsv')
      || mt === 'text/csv'
      || mt === 'text/tab-separated-values'
      || mt.includes('spreadsheetml')
      || mt.includes('ms-excel');
}

// Lightweight CSV/TSV parser. Handles quoted fields with commas, embedded
// newlines, and "" escaped quotes. Returns a 2D array.
function parseCsvText(text, delimiter = ',') {
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++;
      } else { field += c; i++; }
    } else {
      if (c === '"') { inQuotes = true; i++; }
      else if (c === delimiter) { row.push(field); field = ''; i++; }
      else if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; }
      else if (c === '\n' || c === '\r') { row.push(field); rows.push(row); row = []; field = ''; i++; }
      else { field += c; i++; }
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Parse an uploaded spreadsheet buffer into rows. CSV/TSV are handled inline;
// XLSX/XLS require the 'xlsx' npm package (optional — fails gracefully).
function parseSpreadsheetBuffer(buffer, filename) {
  const name = (filename || '').toLowerCase();

  if (name.endsWith('.csv')) {
    return { rows: parseCsvText(buffer.toString('utf8'), ','), format: 'csv' };
  }
  if (name.endsWith('.tsv')) {
    return { rows: parseCsvText(buffer.toString('utf8'), '\t'), format: 'tsv' };
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    try {
      // Optional dependency — only required for Excel files.
      // If not installed, advise the user to `npm install xlsx`.
      const XLSX = require('xlsx');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '', raw: false });
      return { rows, format: name.endsWith('.xlsx') ? 'xlsx' : 'xls' };
    } catch (err) {
      console.warn('[QABot] xlsx module unavailable or parse failed:', err.message);
      return { rows: [], format: null, error: 'xlsx module not installed — run `npm install xlsx` to support Excel files. CSV/TSV still work.' };
    }
  }
  return { rows: [], format: null, error: `Unsupported file format: ${filename}` };
}

// Serialize rows into a compact text block for the AI. Preserves row index so
// the AI can cite specific rows. Drops rows that are entirely empty/whitespace.
function rowsToAiText(rows, maxRows = 200) {
  const out = [];
  const slice = rows.slice(0, maxRows);
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i];
    const cells = (Array.isArray(r) ? r : []).map(c => String(c ?? '').replace(/\s+/g, ' ').trim());
    if (cells.every(c => c === '')) continue; // skip entirely empty rows
    out.push(`[Row ${i + 1}] ${cells.join(' | ')}`);
  }
  return out.join('\n');
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
async function parseBugReport(threadContext, triggerText, assigneeProfiles, assigneeTeamHints) {
  // Build a compact "who was tagged" block the AI can read
  const profileLines = (assigneeProfiles || [])
    .filter(p => p && (p.real || p.display))
    .map(p => `- ${p.label}`);
  const profileBlock = profileLines.length > 0
    ? `\n\nTAGGED USERS IN TRIGGER MESSAGE (their Slack display labels — often contain team in parens like "(iOS)", "(Android)", "(Web)", "(BE)"):\n${profileLines.join('\n')}`
    : '';

  const teamHint = Array.isArray(assigneeTeamHints) && assigneeTeamHints.length > 0
    ? `\n\nEXPLICIT TEAM MAP (from config, most reliable): ${assigneeTeamHints.join(', ')}`
    : '';

  const res = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    system: `You are QABot for Everfit. Your job: parse a QA bug report from a Slack thread and decide the CORRECT platform based on root cause — not just where the bug was seen.

INPUTS YOU RECEIVE:
- TRIGGER MESSAGE: the message that mentioned the bot. Often contains assignment/team hints like "nhờ @X team mobile check", "@BE coi với", "assign to @Y".
- THREAD: the full Slack thread. The FIRST message is the QA's bug report. Later messages are discussion/commands — use them for context (platform hints, team mentions, additional details) but do NOT treat them as the bug itself.
- TAGGED USERS (optional but important): Slack display labels of users the QA @mentioned. At Everfit, dev display names routinely encode their team in parens: "Thinh Le (iOS)" → iOS team, "Lam Bui (Android)" → Android team, "Hung (Web)" → Web, "Ben (BE)" → API/Backend, "Ly Nguyen (QA)" → QA. READ THESE LABELS and use them as a strong platform signal for client-side bugs.
- EXPLICIT TEAM MAP (optional): authoritative team assignments from config. If present, trust these over display labels.

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
- Same bug visible on multiple clients AND the QA is asking for backend investigation
- Reporter pastes a curl / request / response payload as evidence
- Reporter is from BE team, or message says "BE check", "API trả sai", "server returns…"
- Webhook / push notification / email delivery issue
- Permissions/ACL issue

Important nuance: "same bug on iOS and Android" alone does NOT mean backend. If the QA assigns it to a mobile dev and says "fix it on iOS to match Android" (or similar), that means iOS has a CLIENT-side bug where Android is correct — platform is iOS Client/Coach, not API.

If backend signals apply AND the QA is asking for backend investigation → platform = "API".

STEP 2 — CLIENT-SIDE BUG: pick the client platform.
Only reach this step if the bug is clearly a UI/UX/rendering/interaction issue on one specific client.

Priority order for picking the client (STOP at first match):
  2a. EXPLICIT TEAM MAP entry for a tagged user → that user's team.
  2b. TAGGED USER display label contains "(iOS)" → iOS Client (or iOS Coach if coach-facing feature).
      "(Android)" → Android Client (or Android Coach if coach-facing feature).
      "(Web)" → Web. "(BE)" → API.
  2c. Explicit mention in bug text: "trên iOS", "on Android", "Web dashboard", "coach app iOS", etc.
  2d. Explicit team mention in trigger: "team mobile" → iOS Client (or Android if Android explicitly mentioned), "team web" → Web.
  2e. Default: "Web".

Coach vs Client (when platform is mobile):
  - Features used by a COACH managing clients (assign workout, client list, programs, coach dashboard, "Coaching" tab viewed by coach) → iOS Coach / Android Coach
  - Features used by the END USER/client themselves (log their own workout, meal plan, progress photos, macros, calorie display, personal metrics) → iOS Client / Android Client
  - Screenshot showing a phone screen with a single user's personal data = Client app.

Valid platforms (one of): Web, API, iOS Client, iOS Coach, Android Client, Android Coach

====================================================================
ISSUE TYPE DECISION — Bug vs Task:
====================================================================
Decide whether the thread describes a BUG (something broken) or a TASK (a request/change/investigation that isn't fixing broken behavior).

Return "Bug" when:
- Something is broken, crashing, erroring, or producing wrong output
- Behavior deviates from what the user/feature expects ("should X but does Y")
- Data is missing, corrupted, or inconsistent
- A feature that used to work no longer does
- Any thread with error logs, stack traces, 4xx/5xx responses, or crash reports
- The QA is reporting a defect they discovered during testing

Return "Task" when:
- Request to CHANGE existing behavior that currently works correctly (e.g., "change copy from X to Y", "make button blue instead of green", "increase timeout from 5s to 10s")
- Request to ADD something new (a field, a config option, a log, a metric)
- Request for INVESTIGATION or ANALYSIS that isn't tied to a specific defect ("look into how X works", "audit Y")
- Request to UPDATE data/configuration for a specific account ("enable feature X for coach Y", "reset password for client Z")
- Refactor / code quality / tech debt
- Documentation or internal tooling work

Ambiguous case — "investigate why X is slow/failing":
- If X is clearly malfunctioning (errors, timeouts, wrong data) → Bug
- If X works but someone wants to understand it better → Task

Default when truly unclear: "Bug" (QA channel usually reports defects).

====================================================================
OUTPUT — valid JSON only, NO fences, NO explanation, NO thinking outside JSON:
====================================================================
{
  "summary": "[Platform][Feature] Clear English description under 80 chars. No @mentions, no usernames, no 'Nhờ team check'.",
  "type": "Bug" | "Task",
  "priority": "Highest" | "High" | "Medium" | "Low" | "Lowest",
  "platform": "Web" | "API" | "iOS Client" | "iOS Coach" | "Android Client" | "Android Coach",
  "root_cause_reasoning": "One short sentence explaining WHY you picked the platform AND the type (Bug/Task). Reference which signals won.",
  "description": "<see DESCRIPTION FORMAT below — do NOT include any meta text like 'Clean multi-section text' or 'See below' — output only the sections>",
  "assignee_names": ["Full Name of the person the QA tagged to fix. Look for '@X check', 'nhờ @X', '@X fix', '@X coi với'. Empty array if nobody."]
}

====================================================================
DESCRIPTION FORMAT — the value of the "description" field must start DIRECTLY with the first section header (no preamble). Use literal \\n newlines in the JSON string. Pick the template based on the "type" field:

── IF type = "Bug" ──
Steps to reproduce:
1. <step>
2. <step>
3. <step>

Expected behavior:
- <what should happen>

Actual behavior:
- <what is happening>

Environment:
- <browser / device / OS / app version, or N/A>

Note: <test account, PROD/STG, extra context, or N/A>

── IF type = "Task" ──
Request details:
- <clear summary of what needs to be done>

Context:
- <why this is needed, background, related tickets, or N/A>

Acceptance criteria:
- <what "done" looks like — bullet each criterion>

Note: <affected accounts, test data, environment, or N/A>

DO NOT prepend any preamble, heading, or instructional phrase before the first section header.
====================================================================

====================================================================
PRIORITY RUBRIC (unchanged):
====================================================================
"Highest" — Blocker: app down, crash on launch, data loss, payment failure, auth bypass, can't log in at all
"High" — Major: core feature fully broken for many users, crash on common action, PROD-only affecting active users, sync failure blocking usage
"Medium" — Normal: feature partially broken w/ workaround, confusing UX, limited users, typos, UI hiding critical info
"Low" — Minor: spacing/padding/alignment/color on client UI (still understandable), UI flicker, edge-case bugs, nice-to-haves
"Lowest" — Trivial: internal-only cosmetic issues, non-blocking suggestions

NEVER return null/undefined/empty. Always make a reasonable decision. Start your response with "{" immediately — no preamble.`,
    messages: [{
      role: 'user',
      content:
`TRIGGER MESSAGE (this mentioned the bot — contains team/assignment hints):
${triggerText || '(none)'}${profileBlock}${teamHint}

THREAD:
${threadContext}`
    }],
  });

  // ── Robust JSON extraction ──
  // Model might wrap JSON in fences, add preamble, or include thinking text.
  // Extract the first {...} block. If that fails, log the raw response so we
  // can diagnose rather than silently falling back to defaults.
  const rawText = res.content[0].text || '';
  let parsed = null;
  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };

  // Attempt 1: clean fences and parse whole thing
  parsed = tryParse(rawText.replace(/```json|```/g, '').trim());

  // Attempt 2: greedy match of first {...} through last }
  if (!parsed) {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (m) parsed = tryParse(m[0]);
  }

  if (!parsed) {
    console.warn('[QABot] parseBugReport: could not parse AI response as JSON. Raw response follows:');
    console.warn('---BEGIN AI RESPONSE---');
    console.warn(rawText.slice(0, 2000));
    console.warn('---END AI RESPONSE---');
    parsed = {};
  }

  // Defensive defaults — never undefined
  // Also strip any meta-preamble the AI might leak above the real content
  // (e.g. "Clean multi-section text using real newlines:" — that was a prompt
  //  instruction the model occasionally echoed back into the description).
  const cleanedDescription = stripLeakyPreamble(parsed.description);

  return {
    summary:        parsed.summary        || `[Web][Bug] Bug report from QA`,
    type:           parsed.type === 'Task' ? 'Task' : 'Bug',
    priority:       parsed.priority       || 'Medium',
    platform:       parsed.platform       || 'Web',
    root_cause_reasoning: parsed.root_cause_reasoning || '',
    description:    cleanedDescription    || 'Description not parsed. Please update manually.',
    assignee_names: Array.isArray(parsed.assignee_names) ? parsed.assignee_names : [],
  };
}

// Remove any instructional preamble the model echoed above the real content.
// Keeps everything from the first real section header onward (Bug: "Steps to
// reproduce:", Task: "Request details:"). Also trims common meta-phrases.
function stripLeakyPreamble(desc) {
  if (!desc || typeof desc !== 'string') return desc;
  let s = desc;

  // Find the earliest known first-section header and cut everything before it.
  const anchors = [/Steps to reproduce\s*:/i, /Request details\s*:/i];
  let earliest = -1;
  for (const re of anchors) {
    const idx = s.search(re);
    if (idx >= 0 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  if (earliest > 0) s = s.slice(earliest);

  // Otherwise, remove lines that are obvious echoes of prompt instructions.
  const leakyLineRegex = /^[ \t]*(clean multi-section text|see description format|multi-section text|see below|as follows)[^\n]*\n+/gi;
  s = s.replace(leakyLineRegex, '');

  return s.trim();
}

// ── Bulk parser: turn spreadsheet rows into an array of ticket candidates ──
// Uses the same platform/type/priority rules as parseBugReport, but scans the
// whole sheet and returns a list. The AI is responsible for:
//   - recognizing section headers (e.g. "MOBILE (Android Client + iOS Client)",
//     "I. UI/UX Bugs") and using them as CONTEXT for nearby rows
//   - skipping rows that already reference an existing UP-XXXXX ticket
//   - skipping empty, header-only, or informational rows
//   - translating Vietnamese content to English in summaries
async function parseBulkTicketsFromSpreadsheet(rowsText, triggerText, forcedType, assigneeProfiles, maxTickets = 25) {
  const profileLines = (assigneeProfiles || [])
    .filter(p => p && (p.real || p.display))
    .map(p => `- ${p.label}`);
  const profileBlock = profileLines.length > 0
    ? `\n\nTAGGED USERS IN TRIGGER MESSAGE (team labels like "(iOS)", "(Android)", "(Web)", "(BE)" are strong platform hints):\n${profileLines.join('\n')}`
    : '';

  const forcedTypeBlock = forcedType
    ? `\n\nFORCED TYPE: All returned tickets MUST have type="${forcedType}". The user's command explicitly requested this.`
    : '';

  const res = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 8000,
    system: `You are QABot for Everfit, in BULK mode. A QA has attached a spreadsheet (CSV/XLSX) of bug/task candidates. Your job: extract a list of tickets to create in Jira.

INPUT FORMAT:
- TRIGGER MESSAGE: the Slack message where the QA tagged the bot (may contain platform/team hints, a PLAN-XXX epic, or assignment intent).
- TAGGED USERS (optional): display labels of @mentioned users.
- FORCED TYPE (optional): if present, every returned ticket must use that type.
- SPREADSHEET ROWS: the file's rows formatted as "[Row N] col1 | col2 | col3 | ...". Rows are 1-indexed.

HOW TO INTERPRET ROWS:
Spreadsheets from QAs are MESSY. Expect:
1. **Section headers** — e.g. "MOBILE (Android Client + iOS Client)", "I. UI/UX Bugs", "II. Functional Bugs", "IV. Data Bugs", "VIII. FRENCH FORMAT NUMBER". These establish CONTEXT (platform, category) for the bug rows that follow them until the next section header.
2. **Bug rows** — short summaries in one or more cells, sometimes with a details cell and a source cell (e.g. "Message from X in #channel").
3. **Already-filed rows** — contain a "UP-XXXXX" reference or a Jira URL → SKIP these, they already exist.
4. **Empty-looking rows** with only a "Message from ..." note and no summary → SKIP, no actual bug content.
5. **Multi-line cells** — a single cell may contain multiple related items separated by newlines.

HOW TO SPLIT INTO TICKETS:
- One row with a clear summary → one ticket.
- A section header saying "MOBILE (Android + iOS)" with UI bugs underneath → decide platform per row. If the bug is clearly UI on both, pick "iOS Client" as default (user can adjust). If one specific platform is mentioned in the cell, use it.
- Do NOT create a ticket for section headers themselves.
- Do NOT create a ticket for rows already referencing UP-XXXXX.
- Do NOT create tickets for empty/boilerplate rows.
- If a row's summary is too vague to form a useful ticket (e.g., just "Habit" with no context) → include it anyway but prefix the summary with the section context (e.g. "[Android Client][Habit] Localization issue on Habit feature") so the dev knows where to look.

PLATFORM DECISION (per ticket) — follow in order:
1. Explicit platform in the row's text ("iOS", "Android", "Web", "API", "BE") → use that.
2. Nearest section header above the row ("MOBILE ..." → pick mobile, "API ..." → API, etc.).
3. TAGGED USER team labels from the trigger message.
4. Default: "Web".

Valid platforms: Web, API, iOS Client, iOS Coach, Android Client, Android Coach.

TYPE DECISION (per ticket):
- If FORCED TYPE is set, use it for every ticket.
- Otherwise: "Bug" if the row describes broken/crashing/wrong behavior. "Task" if the row describes a change/addition/investigation/data migration.
- Default: "Bug".

PRIORITY DECISION (per ticket) — standard rubric:
- Highest: crash, data loss, payment failure, can't log in.
- High: core feature broken for many users, prod-only affecting active users.
- Medium: partial break with workaround, typos, confusing UX, missing translations.
- Low: cosmetic, alignment, minor edge cases.
- Lowest: internal-only cosmetic.
Default when unclear: "Medium".

SUMMARY FORMAT (per ticket):
"[Platform][Feature] Clear English description under 80 chars."
Translate any Vietnamese content. Never include @mentions, channel names, or "Message from X" text in the summary.

DESCRIPTION FORMAT (per ticket):
For Bug: use headers "Steps to reproduce:", "Expected behavior:", "Actual behavior:", "Environment:", "Note:".
For Task: use headers "Request details:", "Context:", "Acceptance criteria:", "Note:".
If the row doesn't have enough info to fill all headers, use "N/A" for the missing parts and put the row's raw content under "Note:" so the dev can see what the QA wrote.
Always cite the source row: include a "Source: Row N from uploaded spreadsheet" line inside the Note section.

OUTPUT:
Return a valid JSON object (NO fences, NO preamble) with this shape:

{
  "tickets": [
    {
      "summary": "[Platform][Feature] ...",
      "type": "Bug" | "Task",
      "priority": "Highest" | "High" | "Medium" | "Low" | "Lowest",
      "platform": "Web" | "API" | "iOS Client" | "iOS Coach" | "Android Client" | "Android Coach",
      "source_row": <integer — the [Row N] this came from>,
      "description": "...",
      "assignee_names": []
    }
  ],
  "skipped": [
    { "row": <int>, "reason": "already has UP-XXXXX" | "empty" | "section header" | "too vague" }
  ]
}

HARD LIMITS:
- Return AT MOST ${maxTickets} tickets in "tickets". If the sheet has more candidates, pick the most specific/actionable ones and note the rest under "skipped" with reason "over cap — please split into multiple uploads".
- Every returned ticket must have a non-empty summary and description.
- Start your response with "{" immediately — no preamble.`,
    messages: [{
      role: 'user',
      content:
`TRIGGER MESSAGE:
${triggerText || '(none)'}${profileBlock}${forcedTypeBlock}

SPREADSHEET ROWS:
${rowsText}`
    }],
  });

  const rawText = res.content[0].text || '';
  let parsed = null;
  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
  parsed = tryParse(rawText.replace(/```json|```/g, '').trim());
  if (!parsed) {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (m) parsed = tryParse(m[0]);
  }
  if (!parsed) {
    console.warn('[QABot] parseBulkTicketsFromSpreadsheet: could not parse AI JSON. Raw:');
    console.warn(rawText.slice(0, 2000));
    return { tickets: [], skipped: [] };
  }

  const tickets = Array.isArray(parsed.tickets) ? parsed.tickets : [];
  const skipped = Array.isArray(parsed.skipped) ? parsed.skipped : [];

  // Defensive normalization on each ticket
  const clean = tickets.map(t => ({
    summary:        t.summary || '[Web][Bug] Untitled bulk item',
    type:           forcedType || (t.type === 'Task' ? 'Task' : 'Bug'),
    priority:       t.priority || 'Medium',
    platform:       t.platform || 'Web',
    source_row:     typeof t.source_row === 'number' ? t.source_row : null,
    description:    stripLeakyPreamble(t.description) || 'Description not parsed.',
    assignee_names: Array.isArray(t.assignee_names) ? t.assignee_names : [],
  })).slice(0, maxTickets);

  return { tickets: clean, skipped };
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

// Section headers we auto-bold in Jira descriptions.
// Matches the exact labels QABot generates — including any trailing content
// on the same line (so "Slack thread: https://…" keeps the URL as a link).
const HEADER_PATTERNS = [
  /^(Steps to reproduce)(:)(.*)$/i,
  /^(Expected behavior)(:)(.*)$/i,
  /^(Actual behavior)(:)(.*)$/i,
  /^(Request details)(:)(.*)$/i,
  /^(Context)(:)(.*)$/i,
  /^(Acceptance criteria)(:)(.*)$/i,
  /^(Environment)(:)(.*)$/i,
  /^(Notes?)(:)(.*)$/i,
  /^(Slack thread)(:)(.*)$/i,
];

function renderLineAdf(line) {
  for (const re of HEADER_PATTERNS) {
    const m = line.match(re);
    if (!m) continue;
    const headerText = `${m[1]}${m[2]}`;
    const rest = m[3] || '';
    const parts = [{ type: 'text', text: headerText, marks: [{ type: 'strong' }] }];
    if (rest.length > 0) parts.push(...lineToAdfContent(rest));
    return parts;
  }
  return lineToAdfContent(line);
}

function buildAdfDescription(text, curlCommands) {
  const lines = (text || '').split('\n');
  const content = [];
  for (const line of lines) {
    // Skip blank lines entirely — bold headers already separate sections,
    // and empty paragraphs just add unwanted vertical gaps in Jira.
    if (line.trim() === '') continue;
    content.push({ type: 'paragraph', content: renderLineAdf(line) });
  }
  if (Array.isArray(curlCommands) && curlCommands.length > 0) {
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
    issuetype:   { name: ticket.type === 'Task' ? 'Task' : 'Bug' },
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
// Collect all potential parent candidates from the channel canvas. Expensive
// (multiple Jira calls) — bulk mode should call this ONCE and reuse the list.
async function getCanvasParentCandidates(client, channelId) {
  const canvasContent = await getChannelCanvasContent(client, channelId);
  if (!canvasContent) return [];

  const upKeys   = [...new Set((canvasContent.match(/UP-\d+/g)   || []))];
  const planKeys = [...new Set((canvasContent.match(/PLAN-\d+/g) || []))];
  console.log(`[QABot] Canvas keys: UP=${upKeys.join(',')} PLAN=${planKeys.join(',')}`);

  const candidates = [];

  for (const key of upKeys) {
    const title = await getJiraIssueTitle(key);
    if (title) candidates.push({ key, title });
  }

  for (const plan of planKeys) {
    const linked = await getLinkedEpicsFromPI(plan);
    for (const e of linked) {
      if (!candidates.find(c => c.key === e.key)) {
        const title = e.title || await getJiraIssueTitle(e.key);
        if (title) candidates.push({ key: e.key, title });
      }
    }
  }

  if (candidates.length > 0) {
    console.log(`[QABot] Candidates: ${candidates.map(c => `${c.key}="${c.title}"`).join(' | ')}`);
  } else {
    console.log('[QABot] No candidate parents found');
  }
  return candidates;
}

// Pick the parent whose title prefix matches the bug's platform.
function matchCandidateToPlatform(candidates, bugPlatform) {
  if (!candidates || candidates.length === 0) return null;

  const matchPrefix = prefix => candidates.find(p => {
    const lower = (p.title || '').toLowerCase().trim();
    const pf    = prefix.toLowerCase();
    return lower.startsWith(pf + ' -')
        || lower.startsWith(pf + '-')
        || lower.startsWith(pf + ' |')
        || lower.startsWith(pf + '|');
  });

  let priorities;
  switch (bugPlatform) {
    case 'iOS Client':
    case 'iOS Coach':
      priorities = ['iOS', 'Mobile', 'All Platforms']; break;
    case 'Android Client':
    case 'Android Coach':
      priorities = ['Android', 'Mobile', 'All Platforms']; break;
    case 'Web':
      priorities = ['Web', 'All Platforms']; break;
    case 'API':
      priorities = ['API', 'All Platforms']; break;
    case 'CMS':
      priorities = ['CMS', 'All Platforms']; break;
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

// Thin wrapper for single-ticket mode — keeps existing callers working.
async function pickParentFromCanvas(client, channelId, bugPlatform) {
  const candidates = await getCanvasParentCandidates(client, channelId);
  return matchCandidateToPlatform(candidates, bugPlatform);
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

// ── Resolve mentioned Slack users to their display labels ──
// Returns array of "Real Name (display_name)" strings — e.g.
//   ["Thinh Le (Thinh Le (iOS))", "Lam Bui (Lâm Android)"]
// Display names at Everfit often contain the team label in parens:
//   "(iOS)", "(Android)", "(Web)", "(BE)", "(QA)" — which is the single
// strongest signal the bot has for which platform owns the bug.
async function resolveSlackProfiles(client, slackUserIds) {
  const profiles = [];
  for (const id of slackUserIds) {
    try {
      const info = await client.users.info({ user: id });
      const real    = info.user?.real_name || info.user?.profile?.real_name || '';
      const display = info.user?.profile?.display_name || '';
      const label   = display && display !== real ? `${real} (${display})` : (real || id);
      profiles.push({ id, real, display, label });
    } catch (err) {
      console.warn(`[QABot] Could not resolve Slack profile for ${id}:`, err.message);
      profiles.push({ id, real: '', display: '', label: id });
    }
  }
  return profiles;
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

  // Strip mentions from trigger text and normalize for command detection
  const triggerText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const triggerLower = triggerText.toLowerCase();

  // ── Command vocabulary ──
  // Bare mention (just "@qa-bot" or "@qa-bot @person") → show help, do nothing.
  // Create intent → proceed with ticket creation below.
  // Some commands also FORCE the issue type, overriding the AI's decision.
  const createPatterns = [
    'create card', 'create a card', 'create ticket', 'create a ticket',
    'create bug', 'create a bug', 'create task', 'create a task',
    'log bug', 'log task', 'log this', 'log it',
    'report bug', 'file bug',
    'assign to', 'tag as bug', 'make ticket',
  ];
  const hasCreateIntent = createPatterns.some(p => triggerLower.startsWith(p) || triggerLower.includes(` ${p}`));

  // Forced type — command explicitly says "bug" or "task"
  const forcesBug  = /^(create (a )?bug|log bug|report bug|file bug|tag as bug)\b/i.test(triggerText)
                  || /\b(create (a )?bug for|log bug|report bug|file bug)\b/i.test(triggerText);
  const forcesTask = /^(create (a )?task|log task)\b/i.test(triggerText)
                  || /\b(create (a )?task for|log task)\b/i.test(triggerText);
  const forcedType = forcesBug ? 'Bug' : (forcesTask ? 'Task' : null);

  // "Bare" = nothing left after mentions stripped
  const isBare = triggerText.length === 0;

  // ── Bulk mode: spreadsheet attached to the triggering message ──
  // Slack's app_mention event exposes the message's files in event.files.
  // If any of them is a CSV/XLSX/XLS/TSV, this is a bulk request.
  const spreadsheetAttachments = (event.files || []).filter(isSpreadsheetAttachment);
  const isBulk = spreadsheetAttachments.length > 0;

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  const helpText =
    `👋 Hi <@${event.user}>! I'm QABot. Here's what I can do:\n\n` +
    `*Create a ticket (I'll decide Bug or Task automatically):*\n` +
    `• \`@qa-bot create card\` — parse this thread and log to Jira\n` +
    `  _Also: \`create ticket\`, \`log this\`, \`make ticket\`_\n\n` +
    `*Force the type explicitly:*\n` +
    `• \`@qa-bot create bug for ...\` — force type = Bug\n` +
    `  _Also: \`create bug\`, \`log bug\`, \`report bug\`, \`file bug\`_\n` +
    `• \`@qa-bot create task for ...\` — force type = Task\n` +
    `  _Also: \`create task\`, \`log task\`_\n\n` +
    `*Bulk create from a spreadsheet:*\n` +
    `• Attach a CSV/XLSX/XLS/TSV file to your mention + say \`create cards\`\n` +
    `• I'll read the rows and create up to 25 tickets at once\n` +
    `• Use \`create bugs\` / \`create tasks\` to force the type for all rows\n\n` +
    `*Extras:*\n` +
    `• \`@qa-bot assign to @person\` — create a ticket and assign it\n` +
    `• \`@qa-bot create card PLAN-12345\` — link to an Epic\n\n` +
    `⚠️ I only create tickets when you give me an explicit command — just tagging me without a keyword won't create anything.`;

  try {
    // ── Bare mention → show help, exit ──
    if (isBare) {
      logger.info(`[QABot] Bare mention from ${event.user} — showing help`);
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: helpText,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'wave', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Trigger text exists but no recognized create command → also show help ──
    if (!hasCreateIntent) {
      logger.info(`[QABot] Unknown command from ${event.user}: "${triggerText.slice(0, 80)}"`);
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `❓ I didn't recognize that command.\n\n${helpText}`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'question', timestamp: event.ts }).catch(() => {});
      return;
    }

    let context;
    if (event.thread_ts) {
      context = await getThread(client, event.channel, event.thread_ts);
    } else {
      context = triggerText;
    }

    // Skip the short-context guard in bulk mode — the file IS the content.
    if (!isBulk && (!context || context.trim().length < 10)) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: `🤔 Hi <@${event.user}>, I don't see enough content in this thread to log a bug. Please tag me *inside a QA bug thread* that has the actual bug report, or attach a CSV/XLSX file for bulk import.`,
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

    // Resolve display names — at Everfit these routinely contain the team label
    // in parens like "Thinh Le (iOS)", "Lâm Bui (Android)", "Hung (Web)".
    // This is the PRIMARY signal for platform detection, no config needed.
    const assigneeProfiles = await resolveSlackProfiles(client, triggerMentions);
    if (assigneeProfiles.length > 0) {
      logger.info(`[QABot] Tagged profiles: ${assigneeProfiles.map(p => p.label).join(' | ')}`);
    }

    // Optional: authoritative override from TEAM_MAP env var (if configured)
    const assigneeTeamHints = triggerMentions
      .map(id => getTeamForSlackUser(id))
      .filter(Boolean);
    if (assigneeTeamHints.length > 0) {
      logger.info(`[QABot] Team hints from TEAM_MAP: ${assigneeTeamHints.join(', ')}`);
    }

    // ═════════════════════════════════════════════════════════
    // BULK MODE — spreadsheet attached to the mention
    // ═════════════════════════════════════════════════════════
    if (isBulk) {
      const file = spreadsheetAttachments[0]; // process the first spreadsheet
      logger.info(`[QABot] Bulk mode — file="${file.name}" (${Math.round((file.size || 0) / 1024)}KB)`);

      // Download + parse the spreadsheet
      let rows = [], rowsText = '', parseErr = null;
      try {
        const buf = await downloadSlackFile(file.url_private_download || file.url_private);
        const parsed = parseSpreadsheetBuffer(buf, file.name);
        if (parsed.error) parseErr = parsed.error;
        rows = parsed.rows || [];
        rowsText = rowsToAiText(rows);
      } catch (err) {
        parseErr = err.message;
      }

      if (parseErr || rows.length === 0) {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `⚠️ Hi <@${event.user}>, I couldn't read \`${file.name}\`.\n${parseErr ? `_${parseErr}_` : 'The file appears empty or in an unsupported format.'}\n\nSupported: CSV, TSV, XLSX, XLS.`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Let the user know we're working on it — bulk runs can take 30-60s
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `📖 Hi <@${event.user}>, reading \`${file.name}\` (${rows.length} rows)... analyzing with AI, this may take a moment.`,
      });

      // AI extracts ticket candidates from the rows
      const maxTickets = 25;
      const { tickets, skipped } = await parseBulkTicketsFromSpreadsheet(
        rowsText, event.text, forcedType, assigneeProfiles, maxTickets
      );
      logger.info(`[QABot] Bulk parsed: ${tickets.length} tickets, ${skipped.length} skipped`);

      if (tickets.length === 0) {
        const skipSummary = skipped.length > 0
          ? `\n\nSkipped rows:\n${skipped.slice(0, 10).map(s => `• Row ${s.row}: ${s.reason}`).join('\n')}`
          : '';
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `🤔 Hi <@${event.user}>, I couldn't find any actionable bugs/tasks in \`${file.name}\`. Most rows appear to be headers, empty, or already-filed tickets.${skipSummary}`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'shrug', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Resolve shared Jira metadata ONCE for all tickets
      const epicMatch = event.text.match(/\b(PLAN-\d+|UP-\d+)\b/i);
      const epicKey   = epicMatch ? epicMatch[0].toUpperCase() : null;
      const fixVersionId = '12023';
      const sprintId = await getActiveSprintId();
      const reporterJiraId = await resolveJiraAccountId(client, event.user);
      const slackThreadUrl = buildSlackThreadUrl(event.channel, threadTs);

      // Canvas candidates fetched ONCE — matched per ticket below
      const canvasCandidates = await getCanvasParentCandidates(client, event.channel);

      // Create tickets sequentially (avoids Jira rate limits + keeps logs readable)
      const results = [];
      let okCount = 0;
      for (const [idx, t] of tickets.entries()) {
        try {
          // Prepend source metadata to description
          t.description =
            `Slack thread: ${slackThreadUrl}\n` +
            `Source: \`${file.name}\`, Row ${t.source_row || '?'}\n\n` +
            t.description;

          // Resolve per-ticket assignees (falls back to trigger mentions if none suggested)
          let ticketAssigneeIds = triggerMentions;
          if (ticketAssigneeIds.length === 0 && t.assignee_names.length > 0) {
            ticketAssigneeIds = [];
            for (const name of t.assignee_names) {
              const id = await findSlackUserByName(client, name);
              if (id) ticketAssigneeIds.push(id);
            }
          }
          const ticketJiraIds = (
            await Promise.all(ticketAssigneeIds.map(id => resolveJiraAccountId(client, id)))
          ).filter(Boolean);

          const parentKey = matchCandidateToPlatform(canvasCandidates, t.platform);

          const jira = await createJiraIssue(
            t, ticketJiraIds, epicKey, fixVersionId, parentKey, reporterJiraId, []
          );
          if (sprintId) await addIssueToSprint(jira.key, sprintId);

          results.push({ ok: true, jira, ticket: t });
          okCount++;
          logger.info(`[QABot] Bulk ${idx + 1}/${tickets.length}: ${jira.key} — ${t.summary}`);
        } catch (err) {
          const msg = err.response?.data?.errors
            ? Object.entries(err.response.data.errors).map(([f, m]) => `${f}: ${m}`).join(', ')
            : err.message;
          results.push({ ok: false, error: msg, ticket: t });
          logger.warn(`[QABot] Bulk ${idx + 1}/${tickets.length} failed: ${msg}`);
        }
      }

      // Build summary reply
      const lines = results.map((r, i) => {
        if (r.ok) {
          const icon = r.ticket.type === 'Task' ? '📋' : '🐛';
          return `${icon} <${r.jira.url}|${r.jira.key}> · *${r.ticket.priority}* · ${r.ticket.platform} — ${r.ticket.summary}`;
        }
        return `⚠️ Failed: ${r.ticket.summary} _(${r.error})_`;
      });

      const skipLines = skipped.slice(0, 8).map(s => `• Row ${s.row}: ${s.reason}`);
      const skipBlock = skipLines.length > 0
        ? `\n\n_Skipped ${skipped.length} row${skipped.length > 1 ? 's' : ''}:_\n${skipLines.join('\n')}${skipped.length > 8 ? `\n…and ${skipped.length - 8} more` : ''}`
        : '';

      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs, unfurl_links: false,
        text:
          `✅ Hi <@${event.user}>, bulk import complete: *${okCount}/${tickets.length}* tickets created from \`${file.name}\`.\n\n` +
          lines.join('\n') +
          skipBlock,
      });

      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      return;
    }
    // ═════════════════════════════════════════════════════════
    // END BULK MODE
    // ═════════════════════════════════════════════════════════

    // Extract any curl commands from the whole thread for the description
    const curlCommands = extractCurlCommands(context);
    if (curlCommands.length > 0) {
      logger.info(`[QABot] Found ${curlCommands.length} curl command(s) in thread`);
    }

    const ticket = await parseBugReport(context, event.text, assigneeProfiles, assigneeTeamHints);
    logger.info(`[QABot] Parsed: ${ticket.summary} [${ticket.priority}] platform=${ticket.platform} type=${ticket.type}`);
    if (ticket.root_cause_reasoning) {
      logger.info(`[QABot] Root cause: ${ticket.root_cause_reasoning}`);
    }

    // Command-level override: "create bug for..." / "create task for..." wins over AI
    if (forcedType && ticket.type !== forcedType) {
      logger.info(`[QABot] Forcing type: AI said "${ticket.type}" but command said "${forcedType}"`);
      ticket.type = forcedType;
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

    // Greet the triggering QA so it's clear whose report was logged
    const isTask = ticket.type === 'Task';
    const emoji  = isTask ? '📋' : '🐛';
    const label  = isTask ? 'Task created' : 'Bug logged';
    const greeting = `Hi <@${event.user}>, ${label} →`;

    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text:
        `${emoji} ${greeting} <${jira.url}|${jira.key}>\n` +
        `*${ticket.summary}*\n` +
        `Type: *${ticket.type}* · Priority: *${ticket.priority}* · Platform: *${ticket.platform}*\n` +
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
