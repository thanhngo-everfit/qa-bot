// ─────────────────────────────────────────────
// CLIENT REPORT MODULE
// Merged from thanhngo-everfit/bugbot. Owns the 3 monitored
// client-report channels: auto-analysis, create card, followup
// scheduler, weekly report. Activated via register() from index.js.
// ─────────────────────────────────────────────
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const {
  JIRA_HOST, JIRA_PROJECT, jiraAuth,
  SMART_MODEL, aiCall,
  agentStatus, getActiveSprintId, createJiraIssueResilient, FASTPATH, retractOwnMessages, isCreationRequest, isDiscoveryRequest,
  warmUserNames, replaceMentionsCached,
  resolveInlineMentions, qaTaskWork,
} = require('./lib');

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

// ── Channels the bot auto-analyzes (replace IDs with real Slack channel IDs)
// How to find: Channel → right-click → View channel details → Channel ID at bottom
const MONITORED_CHANNELS = {
  'C03H5DCAZ45': 'bug_reporting-internal',
  'C064GEV0D6Z': 'enterprise_bug_reporting_internal',
  'C075QSJS81X': 'customer-request-discussion',
};

// ── Squad Roster (from squad_roster.xlsx) ─────
// Each squad has: SM, PC, BA, role-based engineers, and domain keywords for detection
const SQUAD_ROSTER = {
  // contacts: ordered list — first = lead (SM-level), rest = PC/BA-level.
  // Known Slack IDs are pre-filled; missing ones are resolved from email
  // at runtime via users.lookupByEmail (hydrateRosterIds).
  'Core Product - Training & Automation': {
    contacts: [
      { email: 'thanhngo@everfit.io',      id: 'U0142GU335F' },
      { email: 'duyentran@everfit.io',     id: 'U06401J6QR4' },
      { email: 'anhlethi@everfit.io',      id: null },
    ],
    backend: 'Dong Vo', web: 'Hanh Tran', android: 'Khoa Huynh', ios: 'Tuyen Tran',
    domains: [
      'workout', 'training', 'exercise', 'program', 'autoflow', 'video workout',
      'task assignment', 'master planner', 'gamification', 'leaderboard',
      'studio', 'on-demand', 'sequence',
      'onboarding', 'onboarding flow', 'onboarding form', 'form', 'questionnaire',
      'form assignment', 'assignment',
    ],
  },
  'Core Product - Platform Capability': {
    // Absorbed Integration & Middleware scope (squad dissolved)
    contacts: [
      { email: 'thanhngo@everfit.io',      id: 'U0142GU335F' },
      { email: 'duyentran@everfit.io',     id: 'U06401J6QR4' },
      { email: 'ngocnguyenthi@everfit.io', id: null },
    ],
    backend: 'Hong Tu', web: 'Nhan Huynh', android: 'Lam Bui', ios: 'Thinh Le',
    domains: [
      'login', 'auth', 'authentication', 'permission', 'workspace',
      'localization', 'branding', 'white label', 'notification settings',
      'account settings', 'team settings', 'sign in', 'sign up', 'password',
      // merged from Integration & Middleware
      'integration', 'webhook', 'apple health', 'garmin', 'fitbit',
      'whoop', 'zapier', 'sync', 'middleware', 'health app', 'google calendar',
    ],
  },
  'Core Product - Engagement': {
    contacts: [
      { email: 'baoho@everfit.io', id: 'U0445EQS1ED' },
      { email: 'anhle@everfit.io', id: 'U04PN2RHT4K' },
    ],
    backend: 'Duc Trinh', web: 'Nhan Huynh', android: 'Khoa Huynh', ios: 'Thinh Le',
    domains: [
      'message', 'chat', 'inbox', 'forum', 'community', 'checkin', 'check-in',
      'client profile', 'body metric',
      'habit', 'goal', 'referral', 'affiliate', 'broadcast',
    ],
  },
  'Core Product - Enablement': {
    contacts: [
      { email: 'baoho@everfit.io',     id: 'U0445EQS1ED' },
      { email: 'anhle@everfit.io',     id: 'U04PN2RHT4K' },
      { email: 'duyentran@everfit.io', id: 'U06401J6QR4' },
    ],
    domains: [
      'enablement', 'coach onboarding', 'getting started', 'setup wizard',
      'import client', 'client import', 'csv import', 'data import', 'migration',
    ],
  },
  'Core Product - Nutrition': {
    contacts: [
      { email: 'baoho@everfit.io', id: 'U0445EQS1ED' },
      { email: 'anhle@everfit.io', id: 'U04PN2RHT4K' },
    ],
    backend: 'Dong Vo', web: 'Ha Duong', android: 'Hoai Ho', ios: 'Tan Huynh',
    domains: [
      'nutrition', 'meal', 'macro', 'food', 'diet', 'recipe',
      'myfitnesspal', 'cronometer', 'ingredient', 'calorie', 'meal plan',
    ],
  },
  'AI Features': {
    contacts: [
      { email: 'hoanguyen@everfit.io', id: 'UQZ2PNPN3' },
      { email: 'diemdo@everfit.io',    id: null },
    ],
    domains: [
      'ai', 'artificial intelligence', 'ai feature',
      'ai workout builder', 'ai workout generator', 'ai programming builder', 'push-up challenge',
      'ai recipe builder', 'ai alternative recipe', 'ai recipe',
      'smart response', 'smart-response', 'knowledge base',
      'olly', 'olly voice', 'ask olly',
      'bi dashboard', 'compare check-in',
      'ai suggest', 'ai generate', 'ai coach', 'ai meal', 'ai analysis', 'log food with ai',
    ],
  },
  'Payment & Billing': {
    contacts: [
      { email: 'hoanguyen@everfit.io',  id: 'UQZ2PNPN3' },
      { email: 'tamnguyen@everfit.io',  id: 'U08R7JP31CZ' },
    ],
    domains: [
      'payment', 'billing', 'subscription', 'invoice', 'charge', 'refund',
      'stripe', 'paypal', 'credit card', 'plan upgrade', 'plan downgrade',
      'trial', 'renewal', 'pricing', 'receipt', 'transaction',
      'license', 'licence', 'seat', 'not eligible', 'license assignment',
      'remaining license', 'assigned license',
      'macrosnap', 'macro snap',
    ],
  },
  'Booking': {
    contacts: [
      { email: 'hoanguyen@everfit.io',  id: 'UQZ2PNPN3' },
      { email: 'tamnguyen@everfit.io',  id: 'U08R7JP31CZ' },
    ],
    domains: [
      'booking', 'appointment', 'book a session', 'session booking',
      'availability', 'booking page', 'reschedule', 'booking calendar',
    ],
  },
};

// ── Slack group IDs ───────────────────────────
const GROUP_CS = 'S04UNE5SW9M';
const GROUP_QA = 'S0120RDU4D9';
const GROUP_SM = 'S066VD6SS0G';

// ── Never auto-assign these users ─────────────
const ASSIGNEE_BLOCKLIST = new Set([
  'URH99J5QA', // Quang Pham — Head of Engineering, always cc, never assignee
]);

// ── Platform → Jira parent epic ───────────────
const PLATFORM_PARENTS = {
  'iOS Client': 'UP-23735', 'iOS Coach': 'UP-23735',
  'Android Client': 'UP-23734', 'Android Coach': 'UP-23734',
  'Web': 'UP-23736', 'API': 'UP-23733',
};

// ── Severity definitions (maps to Jira priority + SLA) ──
const SEVERITY_META = {
  Critical: { emoji: '🔴', label: 'Critical', jiraPriority: 'Highest', sla: 'Immediate — same-day fix required' },
  High:     { emoji: '🟠', label: 'High',     jiraPriority: 'High',    sla: 'Urgent — fix within 1–2 working days' },
  Medium:   { emoji: '🟡', label: 'Medium',   jiraPriority: 'Medium',  sla: 'Normal — fix within current sprint' },
  Low:      { emoji: '🟢', label: 'Low',      jiraPriority: 'Low',     sla: 'Minor — schedule in backlog' },
  Trivial:  { emoji: '⚪', label: 'Trivial',  jiraPriority: 'Lowest',  sla: 'Cosmetic — next available cycle' },
};

// ─────────────────────────────────────────────
// APP INIT
// ─────────────────────────────────────────────

let openai = null; // injected by register()
const _registrations = [];
const slackApp = {
  event:  (name, handler) => _registrations.push(['event',  name, handler]),
  action: (name, handler) => _registrations.push(['action', name, handler]),
};

// ── OpenAI wrapper ──
const followUpStore = new Map(); // in-memory follow-up tracker

// ── Knowledge base (loaded at startup, reloaded on SIGHUP) ──
let KNOWLEDGE_BASE = '';
function loadKnowledgeBase() {
  try {
    const kbPath = path.join(__dirname, 'knowledge-base.md');
    if (fs.existsSync(kbPath)) {
      KNOWLEDGE_BASE = fs.readFileSync(kbPath, 'utf8');
      console.log(`✅ Knowledge base loaded (${Math.round(KNOWLEDGE_BASE.length / 1024)} KB)`);
    } else {
      console.warn('[Bot] knowledge-base.md not found — run node knowledge-base-builder.js first');
    }
  } catch (err) {
    console.warn('[Bot] Could not load knowledge base:', err.message);
  }
}
process.on('SIGHUP', loadKnowledgeBase); // hot-reload KB without restart

// Vietnam timezone (UTC+7)
function nowVN() { return new Date(Date.now() + 7 * 60 * 60 * 1000); }
function isWorkingHours() { const h = nowVN().getUTCHours(); return h >= 9 && h < 18; }

// ── Business-hours gate for ALL proactive pings ──────────────────────
// Nobody should be pinged at 00:31 or on a weekend. Mon–Fri only, VN
// time, within working hours (tunable via FOLLOWUP_HOUR_START/END).
function isBusinessTime() {
  const vn    = nowVN();
  const day   = vn.getUTCDay();                 // 0=Sun … 6=Sat
  const hour  = vn.getUTCHours();
  const start = parseInt(process.env.FOLLOWUP_HOUR_START || '9', 10);
  const end   = parseInt(process.env.FOLLOWUP_HOUR_END   || '18', 10);
  if (day === 0 || day === 6) return false;
  return hour >= start && hour < end;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

async function resolveJiraAccountId(slackClient, slackUserId) {
  try {
    const info = await slackClient.users.info({ user: slackUserId });
    const email = info.user?.profile?.email;
    if (!email) return null;
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/user/search`, {
      params: { query: email, maxResults: 1 },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return res.data?.[0]?.accountId ?? null;
  } catch { return null; }
}

async function getThread(client, channelId, threadTs) {
  const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
  const nowMs  = Date.now();
  // Warm all author + mention names in PARALLEL before formatting
  const _uids = new Set();
  for (const msg of result.messages || []) {
    if (msg.user) _uids.add(msg.user);
    for (const m of (msg.text || '').matchAll(/<@([A-Z0-9]+)>/g)) _uids.add(m[1]);
  }
  await warmUserNames(client, [..._uids]);
  const lines  = await Promise.all((result.messages || []).map(async msg => {
    const name = (replaceMentionsCached(`<@${msg.user}>`).replace(/^@/, '') || msg.username || 'user');
    const text = replaceMentionsCached(msg.text || '');
    // Include relative time so Claude knows how old each message is
    const msgMs   = parseFloat(msg.ts) * 1000;
    const hoursAgo = Math.round((nowMs - msgMs) / (60 * 60 * 1000));
    const timeLabel = hoursAgo < 1 ? 'just now'
      : hoursAgo < 24 ? `${hoursAgo}h ago`
      : `${Math.round(hoursAgo / 24)}d ago`;
    return `[${name} — ${timeLabel}]: ${text}`;
  }));
  return lines.join('\n');
}

async function findSlackUserByName(client, name) {
  try {
    const lower = name.toLowerCase();
    const lowerBase = lower.replace(/\s*\(.*?\)\s*/g, '').trim();

    let cursor;
    do {
      const res = await client.users.list({ limit: 200, ...(cursor ? { cursor } : {}) });
      const match = (res.members || []).find(u => {
        const realName    = (u.real_name || '').toLowerCase();
        const displayName = (u.profile?.display_name || '').toLowerCase();
        const userName    = (u.name || '').toLowerCase();
        const email       = (u.profile?.email || '').toLowerCase();
        return (
          realName.includes(lowerBase) ||
          displayName.includes(lowerBase) ||
          userName.includes(lowerBase) ||
          realName.includes(lower) ||
          displayName.includes(lower) ||
          email.startsWith(lowerBase.replace(/\s+/g, ''))
        );
      });
      if (match) return match.id;
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);

    return null;
  } catch { return null; }
}

function buildSlackThreadUrl(channelId, threadTs) {
  return `https://everfitt.slack.com/archives/${channelId}/p${threadTs.replace('.', '')}`;
}

// ── Keyword-based squad detection (fast, no API call) ──
function detectSquadFromKeywords(text) {
  const lower = text.toLowerCase();
  let best = null, bestScore = 0;
  for (const [squad, roster] of Object.entries(SQUAD_ROSTER)) {
    let score = 0;
    for (const kw of roster.domains || []) {
      // Short keywords (<=3 chars, e.g. 'ai') must match as whole words —
      // otherwise 'ai' matches inside 'email'/'said'. Longer keywords use
      // substring match. Score = keyword length, so specific feature names
      // ('smart response') always outweigh generic areas ('inbox').
      const hit = kw.length <= 3
        ? new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
        : lower.includes(kw);
      if (hit) score += kw.length;
    }
    if (score > bestScore) { bestScore = score; best = squad; }
  }
  return best;
}

function getSquadContacts(squad) {
  return SQUAD_ROSTER[squad]?.contacts || null;
}

// Resolve missing Slack IDs from emails once at startup (users.lookupByEmail)
let _rosterHydrated = false;
async function hydrateRosterIds(client) {
  if (_rosterHydrated) return;
  _rosterHydrated = true;
  for (const roster of Object.values(SQUAD_ROSTER)) {
    for (const c of roster.contacts || []) {
      if (c.id) continue;
      try {
        const res = await client.users.lookupByEmail({ email: c.email });
        c.id = res.user?.id || null;
        if (c.id) console.log(`[Roster] ${c.email} → ${c.id}`);
      } catch (err) {
        console.warn(`[Roster] Could not resolve ${c.email}:`, err.data?.error || err.message);
      }
    }
  }
}

function getRecommendedAssignee(squad, platform) {
  const r = SQUAD_ROSTER[squad];
  if (!r) return null;
  const roleMap = {
    'iOS Client': 'ios', 'iOS Coach': 'ios',
    'Android Client': 'android', 'Android Coach': 'android',
    'Web': 'web', 'API': 'backend',
  };
  return r[roleMap[platform]] || r.backend || null;
}

// ─────────────────────────────────────────────
// MEMBER → PLATFORM RESOLUTION
// Used to set the correct ticket platform prefix based on WHO it's
// assigned to (e.g. bug reported on Web but assigned to a BE member → API)
// ─────────────────────────────────────────────

// Fallback map from squad roster (only unambiguous names; display-name
// suffix is the primary signal). Ambiguous names like Duy Nguyen /
// Hoang Nguyen (two roles in different squads) are intentionally omitted.
const MEMBER_PLATFORM_MAP = {
  // Backend → API
  'dong vo': 'API', 'nhat huy': 'API', 'duy le': 'API', 'trung huynh': 'API',
  'long nguyen': 'API', 'hoang tuan nguyen': 'API', 'duc trinh': 'API',
  'viet mai': 'API', 'thuong huynh': 'API', 'hong tu': 'API', 'viet phung': 'API',
  'chien nguyen': 'API', 'quy hoang': 'API', 'linh nguyen': 'API',
  'dat phan': 'API', 'huy be': 'API', 'long thai': 'API', 'hung nguyen': 'API',
  // Web
  'hanh tran': 'Web', 'anh phan': 'Web', 'ha duong': 'Web', 'nhan huynh': 'Web',
  'toan tran': 'Web', 'thai bui': 'Web', 'huy tran': 'Web', 'vinh tran': 'Web',
  'hieu le': 'Web', 'thanh nguyen': 'Web', 'thinh huynh': 'Web', 'trung nguyen': 'Web',
  // Android
  'khoa huynh': 'Android', 'hoai ho': 'Android', 'long phan': 'Android',
  'danh truong': 'Android', 'lam bui': 'Android',
  // iOS
  'tuyen tran': 'iOS', 'tan huynh': 'iOS', 'thinh le': 'iOS',
  'thanh tran': 'iOS', 'canh tran': 'iOS',
};

// ── Get a member's platform from Slack display name suffix or roster ──
// Returns 'API' | 'Web' | 'iOS' | 'Android' | null
async function getMemberPlatformFamily(client, slackUserId) {
  try {
    const info = await client.users.info({ user: slackUserId });
    const displayName = info.user?.profile?.display_name || info.user?.real_name || '';

    // Primary: parse role suffix from display name, e.g. "Nhat Huy (BE)"
    const suffixMatch = displayName.match(/\(([^)]+)\)\s*$/);
    if (suffixMatch) {
      const role = suffixMatch[1].trim().toLowerCase();
      if (['be', 'backend'].includes(role))            return 'API';
      if (['fe', 'web', 'frontend'].includes(role))    return 'Web';
      if (['ios'].includes(role))                      return 'iOS';
      if (['and', 'android'].includes(role))           return 'Android';
      // (PC), (SM), (QA), (CS) etc. — not a dev platform, fall through
    }

    // Fallback: roster name map (strip suffix before lookup)
    const baseName = displayName.replace(/\s*\(.*?\)\s*$/, '').trim().toLowerCase();
    return MEMBER_PLATFORM_MAP[baseName] || null;
  } catch { return null; }
}

// ── Apply a platform family to a ticket: fix platform field + summary prefix ──
// family: 'API' | 'Web' | 'iOS' | 'Android'
// Keeps Client/Coach variant when the AI already picked the same family.
function applyPlatformToTicket(ticket, family) {
  if (!family) return ticket;

  const PLATFORMS = ['iOS Client', 'iOS Coach', 'Android Client', 'Android Coach', 'Web', 'API'];
  let newPlatform;
  if (family === 'API' || family === 'Web') {
    newPlatform = family;
  } else {
    // iOS / Android: preserve Client/Coach variant if AI platform is same family
    const aiPlatform = ticket.platform || '';
    newPlatform = aiPlatform.startsWith(family) ? aiPlatform : `${family} Client`;
  }

  if (newPlatform === ticket.platform) return ticket;

  // Rewrite the platform bracket in the summary
  let summary = ticket.summary;
  for (const p of PLATFORMS) {
    if (summary.includes(`[${p}]`)) {
      summary = summary.replace(`[${p}]`, `[${newPlatform}]`);
      break;
    }
  }

  return { ...ticket, platform: newPlatform, summary };
}

// ── Parse trigger message: separate direct assignees from cc/fyi mentions ──
// "assign to @A @B cc @C" → { assignees: [A, B], ccIds: [C] }
function parseAssigneesFromTrigger(rawText, botUserId) {
  // Find where cc/fyi starts (if anywhere)
  const ccMatch = rawText.match(/\b(cc|fyi)\b/i);
  const ccIndex = ccMatch ? ccMatch.index : Infinity;

  const assignees = [];
  const ccIds     = [];
  const re = /<@([A-Z0-9]+)>/g;
  let m;
  while ((m = re.exec(rawText)) !== null) {
    const id = m[1];
    if (id === botUserId || ASSIGNEE_BLOCKLIST.has(id)) continue;
    if (m.index > ccIndex) ccIds.push(id);
    else assignees.push(id);
  }
  return { assignees, ccIds };
}

// ── Normalize ticket title into canonical bracket format ──
// The AI (gpt-4o-mini) sometimes produces messy titles. This rebuilds
// the title deterministically: [Client Report|Client Request][Platform]
// [Fix data?][Feature?] Description — regardless of what the model returned.
function normalizeTicketSummary(ticket, analysis) {
  const PLATFORMS = ['iOS Client', 'iOS Coach', 'Android Client', 'Android Coach', 'Web', 'API'];
  const rawSummary = ticket.summary || '';

  // Extract all bracket tokens and the free text after them
  const brackets = [...rawSummary.matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim());
  let text = rawSummary.replace(/\[[^\]]*\]/g, '').trim();

  // Strip thread-transcript artifacts and Slack tags if they leaked in
  text = text
    .replace(/^[^:]{0,40}—\s*\d+[hdm]\s*ago\s*:?/i, '')   // "Name — 13h ago:"
    .replace(/<!subteam\^[^>]+>/g, '')
    .replace(/<@[A-Z0-9]+(\|[^>]+)?>/g, '')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<https?:\/\/[^\s>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Fallback description text from issue_summary if empty or Vietnamese-transcript-like
  if (!text || text.length < 10) {
    text = (analysis.issue_summary || 'Client reported issue').split(/[.!?]/)[0].trim();
  }
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (text.length > 100) text = text.substring(0, 100).trim();

  // Report-type token
  const reportToken = brackets.find(b => /client\s*(report|request)/i.test(b));
  const normalizedReport = reportToken && /request/i.test(reportToken) ? 'Client Request' : 'Client Report';

  // Platform: ticket.platform field wins if valid, else bracket, else Web
  const bracketPlatform = brackets.find(b => PLATFORMS.some(p => p.toLowerCase() === b.toLowerCase()));
  const platform = PLATFORMS.includes(ticket.platform) ? ticket.platform
    : bracketPlatform ? PLATFORMS.find(p => p.toLowerCase() === bracketPlatform.toLowerCase())
    : 'Web';

  const fixData = brackets.some(b => /fix\s*data/i.test(b));

  // Feature: first bracket that isn't report-type / platform / fix data
  const feature = brackets.find(b =>
    !/client\s*(report|request)|fix\s*data/i.test(b) &&
    !PLATFORMS.some(p => p.toLowerCase() === b.toLowerCase())
  );

  const prefix = [`[${normalizedReport}]`, `[${platform}]`];
  if (fixData) prefix.push('[Fix data]');
  if (feature) prefix.push(`[${feature}]`);

  return { ...ticket, platform, summary: `${prefix.join('')} ${text}` };
}


// ── Build @mentions from hardcoded IDs ───────
function resolveContactMentions(contacts) {
  if (!contacts || !contacts.length) return null;
  const m = c => c.id ? `<@${c.id}>` : `*${c.email.split('@')[0]}*`;
  return {
    smMention: m(contacts[0]),
    pcMention: contacts.slice(1).map(m).join(' ') || m(contacts[0]),
  };
}

// ─────────────────────────────────────────────

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;   // Jira chokes above this anyway
const MAX_ATTACHMENTS      = 8;

async function getAllThreadAttachments(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    const atts = [];
    for (const msg of result.messages || []) {
      for (const f of msg.files || []) {
        if (!f.url_private_download) continue;
        if ((f.size || 0) > MAX_ATTACHMENT_BYTES) {
          console.log(`[Bot] Skipping large attachment ${f.name} (${Math.round((f.size || 0) / 1048576)}MB)`);
          continue;
        }
        atts.push({ name: f.name || 'attachment', url: f.url_private_download, mimetype: f.mimetype || 'application/octet-stream', size: f.size || 0 });
        if (atts.length >= MAX_ATTACHMENTS) return atts;
      }
    }
    return atts;
  } catch { return []; }
}

async function downloadSlackFile(url) {
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: MAX_ATTACHMENT_BYTES,
  });
  return Buffer.from(res.data);
}

async function uploadAttachmentToJira(issueKey, filename, fileBuffer, mimetype) {
  try {
    const form = new FormData();
    form.append('file', fileBuffer, { filename, contentType: mimetype });
    await axios.post(`${JIRA_HOST}/rest/api/3/issue/${issueKey}/attachments`, form, {
      headers: { ...form.getHeaders(), Authorization: jiraAuth(), 'X-Atlassian-Token': 'no-check' },
    });
    return true;
  } catch (err) {
    console.warn(`[Bot] Attachment upload failed (${filename}):`, err.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// JIRA
// ─────────────────────────────────────────────


async function addIssueToSprint(issueKey, sprintId) {
  try {
    await axios.post(
      `${JIRA_HOST}/rest/agile/1.0/sprint/${sprintId}/issue`,
      { issues: [issueKey] },
      { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
  } catch (err) { console.warn('[Bot] Could not add to sprint:', err.message); }
}

// ─────────────────────────────────────────────
// ADF BUILDER (Jira rich text format)
// ─────────────────────────────────────────────

const BOLD_HEADER_RE = /^(Slack thread|Squad|Severity|Reported by|Intercom link|Affected area|Steps to reproduce|Expected behavior|Actual behavior|Request details|Resolution Steps|Notes?)(:)(.*)$/i;

function lineToAdfContent(line) {
  // Unwrap markdown-style angle-bracket links: <https://x> → https://x
  line = line.replace(/<(https?:\/\/[^>\s]+)>/g, '$1');

  // Tokenize inline **bold** and bare URLs into ADF text nodes with marks
  const tokenRe = /\*\*([^*]+)\*\*|(https?:\/\/[^\s<>]+)/g;
  const parts = [];
  let last = 0, m;
  while ((m = tokenRe.exec(line)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: line.slice(last, m.index) });
    if (m[1] !== undefined) {
      parts.push({ type: 'text', text: m[1], marks: [{ type: 'strong' }] });
    } else {
      // Trim trailing punctuation that isn't part of the URL
      let url = m[2];
      const trailing = url.match(/[).,;:!?]+$/);
      if (trailing) url = url.slice(0, -trailing[0].length);
      parts.push({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] });
      if (trailing) parts.push({ type: 'text', text: trailing[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ type: 'text', text: line.slice(last) });
  return parts.length ? parts : [{ type: 'text', text: line }];
}

function renderLineAdf(line) {
  const m = line.match(BOLD_HEADER_RE);
  if (m) {
    const parts = [{ type: 'text', text: `${m[1]}${m[2]}`, marks: [{ type: 'strong' }] }];
    if (m[3]) parts.push(...lineToAdfContent(m[3]));
    return parts;
  }
  return lineToAdfContent(line);
}

// Full markdown -> ADF converter — same format as QA Bot's normal tickets:
// ## headings, ordered lists (1. 2.), bullet lists (- ), **bold**, links.
function buildAdfDescription(text) {
  const lines = (text || '').split('\n').filter(l => l.trim() !== '');
  const content = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: renderLineAdf(lines[i].trim().replace(/^\d+\.\s+/, '')) }] });
        i++;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }

    if (/^-\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^-\s/.test(lines[i].trim())) {
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: renderLineAdf(lines[i].trim().replace(/^-\s+/, '')) }] });
        i++;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }

    if (line.startsWith('## ')) {
      content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: line.slice(3).trim() }] });
      i++;
      continue;
    }

    content.push({ type: 'paragraph', content: renderLineAdf(line) });
    i++;
  }

  return { type: 'doc', version: 1, content };
}

async function createJiraIssue(ticket, jiraAccountIds) {
  const sevMeta = SEVERITY_META[ticket.severity] || SEVERITY_META.Medium;
  // Reference section appended in code so the thread link is never lost
  let descText = (ticket.description || '').trim().replace(/^Slack thread:.*$/m, '').trim();
  if (ticket.slackThreadUrl) descText += `\n\n## Reference\n- Slack thread: ${ticket.slackThreadUrl}`;
  const fields = {
    project:     { key: JIRA_PROJECT },
    summary:     ticket.summary,
    issuetype:   { name: ticket.type && !/^(bug|task)$/i.test(ticket.type) ? ticket.type : (ticket.type === 'Task' ? 'Task' : 'Bug') },
    priority:    { name: sevMeta.jiraPriority },   // derived from severity
    description: buildAdfDescription(descText),
    fixVersions: [{ id: '27643' }],
  };
  // An explicit parent from the request ("under this parent UP-x") beats
  // the default platform parent
  const parentKey = ticket.explicitParent || PLATFORM_PARENTS[ticket.platform];
  if (parentKey) fields.parent = { key: parentKey };
  if (jiraAccountIds.length) fields.assignee = { accountId: jiraAccountIds[0] };

  const { key, notes } = await createJiraIssueResilient(fields);
  if (notes.length) console.log(`[Bot] ${key} created with adjustments: ${notes.join(' · ')}`);
  return { key, url: `${JIRA_HOST}/browse/${key}`, notes };
}

// ─────────────────────────────────────────────
// CORE AI ANALYSIS  ─  single Sonnet 4 call
// ─────────────────────────────────────────────

async function analyzeThread(context, slackThreadUrl, userDirective = '') {
  // Trim KB to avoid hitting token limits while keeping the most useful sections
  const kbSection = KNOWLEDGE_BASE
    ? `\n\n---\n📚 KNOWLEDGE BASE — use patterns below to determine severity and resolution steps:\n${KNOWLEDGE_BASE.substring(0, 7000)}\n---\n`
    : '';

  const squadList = Object.keys(SQUAD_ROSTER).join('\n  - ');

  const systemPrompt = `You are QA Agent, the internal issue-triage assistant for Everfit — a B2B fitness coaching SaaS platform.

Your job: read a Slack support/bug thread and return a single structured JSON object that drives both a Slack auto-reply and Jira ticket creation.

════════════════════════════════════════════
⚠️ MANDATORY LANGUAGE RULE — HIGHEST PRIORITY:
ALL output MUST be written in ENGLISH ONLY. The Slack threads are mostly in
Vietnamese — you MUST translate everything into clear, professional English.
This applies to EVERY field: issue_summary, root_cause_hypothesis, impact,
severity_rationale, ticket summary, description, resolution_steps.
NEVER output Vietnamese text anywhere. If a Vietnamese message says
"Coach report không gửi được photo", write "Coach reports being unable to send photos".

⚠️ MANDATORY FORMAT RULE:
The ticket summary MUST follow the exact bracket format below, and the
description MUST follow the exact template below — same section order,
same labels, no sections skipped, no extra sections invented.
${kbSection}

════════════════════════════════════════════
SQUADS — detect from the issue context:
  - ${squadList}

SQUAD ROUTING HINTS:
  ⚠️ PRECEDENCE RULE — FEATURE NAME BEATS LOCATION:
  When a specific feature/product is the subject of the issue, route by
  THAT FEATURE — even if it appears inside inbox, messages, workout or
  any other screen. Example: "Smart Response pop-up in inbox" → the
  subject is Smart Response (AI Features), NOT inbox (Engagement).

  Valid squads (use these EXACT names):
  - "Core Product - Training & Automation": Autoflow, Onboarding Flow, onboarding
    forms, form assignment, questionnaires, task assignment, workouts, programs
  - "Core Product - Platform Capability": login/auth, permissions, workspace &
    account settings, white label, localization, AND all integrations/middleware
    (Apple Health, Garmin, Fitbit, Whoop, Zapier, webhooks, sync, Google Calendar)
    — the former Integration & Middleware squad merged into this one
  - "Core Product - Engagement": messages/inbox/chat (as a feature itself),
    forum, check-ins, habits, goals, client profile, referral, broadcast
  - "Core Product - Enablement": coach onboarding/getting started, client
    import/migration, setup flows
  - "Core Product - Nutrition": meals, macros, recipes, MyFitnessPal, Cronometer
  - "AI Features": AI Workout Builder, AI Recipe Builder, AI Alternative Recipe,
    Olly / Olly Voice / Ask Olly, Smart Response, Knowledge Base, BI Dashboard,
    Push-up Challenge, Compare Check-in, anything AI-generated
  - "Payment & Billing": payments, subscriptions, invoices, refunds, Stripe,
    licenses/seats, MacroSnap
  - "Booking": appointments, session booking, availability, booking pages

  - If issue involves BOTH an AI feature bug AND a license/billing error
    → create 2 tickets: one for "AI Features", one for "Payment & Billing"

PLATFORM DETECTION (strict):
  - iOS Client / iOS Coach   → user describes iOS app behavior
  - Android Client / Coach   → user describes Android behavior
  - Web                      → issue on the web dashboard / browser
  - API                      → backend/data fix, account changes, email updates, sync errors, anything needing DB/server access

════════════════════════════════════════════
SEVERITY STANDARD — apply strictly, this determines urgency and SLA:

  🔴 Critical
     WHEN: production outage, data loss/corruption, security breach, payment failure,
           complete login failure for all users, crash on launch, GDPR/legal risk.
     SLA: Same-day fix required.

  🟠 High
     WHEN: core feature fully broken with NO workaround, crash on a common user action,
           billing/subscription access broken for a paying coach, sync failure blocking
           daily coaching work for multiple users.
     SLA: Fix within 1–2 working days.

  🟡 Medium
     WHEN: feature partially broken but a workaround exists, issue isolated to 1 account/device,
           confusing UX blocking a specific task, typo in critical copy, minor data display error,
           account update request (email change, etc.), UI misalignment causing confusion.
     SLA: Fix within current sprint.

  🟢 Low
     WHEN: cosmetic spacing/padding/color issue, minor visual glitch, edge case affecting <1%
           of users, nice-to-have improvement, non-blocking inconsistency.
     SLA: Schedule in backlog.

  ⚪ Trivial
     WHEN: internal-only cosmetic issue, dev/staging env only, theoretical concern.
     SLA: Next available cycle.

  Severity drives the Jira priority field:
    Critical → Highest | High → High | Medium → Medium | Low → Low | Trivial → Lowest

════════════════════════════════════════════
TICKET CLASSIFICATION:
  - Bug: something broken, crashing, not working as designed
  - Task: account/data change, feature request, configuration, access request

TICKET COUNT — decide from the thread content:
  - Default for a single reported problem: 1 ticket.
  - MULTIPLE DISTINCT ISSUES → MULTIPLE TICKETS: if the thread identifies
    several distinct issues (numbered sections like "1./2./3." or "####",
    separate root causes, different features/screens/symptoms), create ONE
    TICKET PER DISTINCT ISSUE — up to 6. Each ticket gets its own accurate
    title, platform, and description built from that issue's own details.
    NEVER collapse distinct diagnosed issues into one generic ticket like
    "app experiencing random issues".
  - Data-fix + root-cause pattern → 2 tickets (Task for the immediate fix,
    Bug for the code fix).
  - If the REQUESTER DIRECTIVE asks for a ticket per issue ("create tickets
    for each issue", "log 5 cards", "tách card từng lỗi"), one ticket per
    issue is MANDATORY, not optional.

TITLE PREFIX FORMAT (required, never leave the description after brackets empty):
  Bug from client/coach    → [Client Report][Platform][Feature] Short description
  Data fix for client      → [Client Report][Platform][Fix data][Feature] Short description
  Request from client      → [Client Request][Platform][Feature] Short description
  Internal / no client     → [Platform][Feature] Short description

  Platform = exactly one of: Web | API | iOS Client | iOS Coach | Android Client | Android Coach

════════════════════════════════════════════
ASSIGNEE DETECTION (ordered by confidence):
  1. Explicit in thread: "nhờ X check", "assign to X", "@X làm cái này", "@X help e"
  2. Acceptance reply: person was asked AND responded "ok", "được", "để a xem", "a check"
  3. Last person tagged with a task/request in the thread
  4. Return [] if genuinely unclear
  NEVER assign Quang Pham. Ignore "cc" lines entirely.

════════════════════════════════════════════
OUTPUT — return ONLY valid JSON (no markdown fences, no extra text).
REMINDER: every string value below must be in ENGLISH — translate all Vietnamese.

{
  "issue_summary": "2–3 sentence plain-English summary of what happened and who is affected",
  "root_cause_hypothesis": "1-sentence SPECIFIC hypothesis tied to this report's details (from KB patterns or the symptoms), or null. Never generic ('may be a sync issue').",
  "checks": ["0-3 concrete things a dev should check FIRST, specific to THIS report — e.g. a gap with hard start/end dates → check whether other clients have the same gap from that date (systemic?), check logs in that exact window. EMPTY ARRAY if nothing specific stands out — never generic advice."],
  "missing_info": ["0-3 questions CS should answer — facts the report omits that block investigation (e.g. which integration: Apple Health / Google Fit / Fitbit / Garmin; device; app version; whether data exists in the source app). EMPTY ARRAY if the report is complete."],
  "impact": "concise impact statement (e.g. '1 coach on iOS, cannot complete check-in')",
  "severity": "Critical|High|Medium|Low|Trivial",
  "severity_rationale": "1 sentence explaining WHY this severity, citing the standard above",
  "tickets": [
    {
      "summary": "Title in [Prefix][Platform][Feature] format — description after brackets REQUIRED",
      "type": "Bug|Task",
      "severity": "Critical|High|Medium|Low|Trivial",
      "platform": "iOS Client|iOS Coach|Android Client|Android Coach|Web|API",
      "squad": "exact squad name",
      "description": "full Jira ticket body — use the template below",
      "assignee_names": ["Full Name as it appears in Slack"],
      "resolution_steps": [
        "Step 1: ...",
        "Step 2: ..."
      ]
    }
  ]
}

DESCRIPTION TEMPLATE (Bug) — use this EXACT structure with ## section headings (real newlines, **bold** for key terms):

## Bug Description
[1-3 sentences: what exactly is broken, under what conditions, who is affected. Specific — use thread details.]

## Report Info
- **Reported by:** <coach/client name AND email — NOT the CS/SM who posted>
- **Intercom:** <URL if found, else omit this line>
- **Squad:** <squad>
- **Severity:** <severity> — <one-line rationale>

## Root Cause
[Why this happens technically. From thread if stated, else a concise inference from symptoms. Never N/A.]

## Expected Behavior
- [what SHOULD happen]

## Steps to Reproduce
1. [specific step from thread]
2. [specific step]

## Resolution Steps
- [step from KB pattern if applicable — omit this section entirely if nothing useful]

DESCRIPTION TEMPLATE (Task / Data fix) — use this EXACT structure with ## section headings:

## Context
[2-3 sentences: who requested this, what needs to be done, and why. Business context from the thread.]

## Report Info
- **Reported by:** <coach/client name AND email>
- **Intercom:** <URL if found, else omit this line>
- **Squad:** <squad>
- **Severity:** <severity> — <one-line rationale>

## Requirements
1. **[Short label]** — [specific description of what needs to be done]
2. **[Short label]** — [specific description, add more as needed]

ISSUE TYPE RULE: broken/incorrect behavior → Bug. Data fix, config change, account/email update, enable feature, export request, or any "please do X" → Task. Pick per ticket.
Do NOT include the Slack thread link in the description — it is appended automatically as a Reference section.`;

  const userContent = userDirective
    ? `REQUESTER DIRECTIVE (obey this): ${userDirective}\n\nSlack thread:\n\n${context}`
    : `Slack thread:\n\n${context}`;
  // Explicit user commands get the stronger model and a larger budget so
  // multi-ticket outputs (5-6 full descriptions) never truncate mid-JSON.
  // Auto-analysis runs on every new report: keep it lean and give it a
  // short leash (45s) so a slow endpoint falls back fast instead of
  // leaving 'I'm analyzing the report' hanging in the thread.
  const rawResponse = await aiCall(
    systemPrompt, userContent,
    userDirective ? 6000 : 2500, true,
    userDirective ? 'gpt-4o' : 'gpt-4o-mini',
    userDirective ? null : 60000,
  ); // jsonMode

  // Robust JSON extraction: strip fences, then take first { … last }
  let raw = rawResponse.replace(/```json|```/g, '').trim();
  const firstBrace = raw.indexOf('{');
  const lastBrace  = raw.lastIndexOf('}');
  if (firstBrace > -1 && lastBrace > firstBrace) raw = raw.substring(firstBrace, lastBrace + 1);

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e1) {
    // Repair pass: gpt-4o-mini often emits literal newlines/tabs inside
    // string values, which is invalid JSON. Replacing them with spaces
    // keeps structure valid (structural whitespace tolerates spaces).
    try {
      parsed = JSON.parse(raw.replace(/\r/g, '').replace(/[\n\t]/g, ' '));
      console.warn('[Bot] AI JSON needed newline repair — parsed on 2nd attempt');
    } catch (e2) {
      console.warn('[Bot] AI JSON parse failed twice:', e2.message, '— raw head:', rawResponse.substring(0, 200));
    }
  }

  if (parsed) {
    if (Array.isArray(parsed.tickets)) {
      parsed.tickets = parsed.tickets.map(t => ({ ...normalizeTicketSummary(t, parsed), slackThreadUrl }));
    }
    return parsed;
  }

  {

    // Build a CLEAN fallback title from the parent message — never the raw transcript
    const firstLine = context.split('\n')[0]
      .replace(/^\[[^\]]*\]:\s*/, '')                 // strip "[Name — 13h ago]:" prefix
      .replace(/<!subteam\^[^>]+>/g, '')
      .replace(/<@[A-Z0-9]+(\|[^>]+)?>/g, '')
      .replace(/@[A-Z0-9]{9,11}\b/g, '')
      .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
      .replace(/<https?:\/\/[^\s>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 120);

    // Translate to a short ENGLISH title (plain text — far more reliable than JSON)
    let englishTitle = firstLine;
    try {
      englishTitle = (await aiCall(
        'Rewrite this bug report snippet as ONE short English ticket title (max 12 words). Output plain text only — no quotes, no brackets, English only.',
        firstLine, 60, false, 'gpt-4o-mini', 20000
      )).trim().replace(/^["'\s]+|["'\s]+$/g, '').substring(0, 90) || firstLine;
    } catch (_) {}

    return {
      issue_summary:         englishTitle || 'Client reported an issue (details in thread)',
      root_cause_hypothesis: null,
      impact:                'Unknown — AI response could not be parsed, please review thread',
      severity:              'Medium',
      severity_rationale:    'Defaulted to Medium (AI parse error — please verify)',
      tickets: [{
        summary:          `[Client Report][Web][General] ${englishTitle || 'Client reported issue — see Slack thread'}`,
        slackThreadUrl,
        type:             'Bug',
        severity:         'Medium',
        platform:         'Web',
        squad:            null,
        description:      `Slack thread: ${slackThreadUrl}\n\n⚠️ Auto-generated fallback (AI parse error) — please edit this ticket with correct details.\n\nOriginal thread content:\n${context.substring(0, 2000)}`,
        assignee_names:   [],
        resolution_steps: [],
      }],
    };
  }
}

// ─────────────────────────────────────────────
// REPLY BUILDERS
// ─────────────────────────────────────────────

// Analysis reply — used by auto-analyze and @QA Bot analyze
// Analysis reply as Block Kit: the same text (kept in `text` too, so every
// parser that reads bot replies keeps working) plus an Assign button that
// opens a member picker and creates + assigns the Jira card.
// Run the analysis under a hard budget. If it overruns or fails, post a
// minimal reply that still carries the Assign button — the team can act
// even when the AI endpoint is slow.
async function analyzeWithBudget(context, slackThreadUrl, budgetMs = 100000) {
  const t0 = Date.now();
  try {
    const out = await Promise.race([
      analyzeThread(context, slackThreadUrl),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`analysis exceeded ${budgetMs / 1000}s`)), budgetMs)),
    ]);
    console.log(`[Bot] Analysis done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { analysis: out, degraded: null };
  } catch (err) {
    console.warn(`[Bot] Analysis failed after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err.message}`);
    return { analysis: null, degraded: err.message };
  }
}

function degradedAnalysisText(reason) {
  return `I couldn't complete the analysis this time (${reason.substring(0, 120)}).\n\n` +
         `You can still assign it below, or tag me with _"analyze"_ to retry.`;
}

function analysisBlocks(text, channelId, threadTs) {
  const blocks = [];
  let chunk = '';
  for (const para of (text || '').split('\n\n')) {
    // section text limit is 3000 chars — pack paragraphs under it
    if ((chunk + '\n\n' + para).length > 2800 && chunk) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
      chunk = para;
    } else {
      chunk = chunk ? `${chunk}\n\n${para}` : para;
    }
  }
  if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button', style: 'primary', action_id: 'qa_assign_open',
      text: { type: 'plain_text', text: 'Assign', emoji: true },
      value: JSON.stringify({ c: channelId, t: threadTs }),
    }],
  });
  return blocks;
}

function buildAnalysisReply(analysis, squad, contacts, reporterId = null) {
  const { issue_summary, root_cause_hypothesis, severity, tickets } = analysis;
  const sev = SEVERITY_META[severity] || SEVERITY_META.Medium;
  const lines = [];

  const isBug = (tickets || []).some(t => t.type === 'Bug');

  // Platform → dev role label
  const roleOf = p =>
    p === 'API' ? 'BE'
    : p === 'Web' ? 'Web'
    : (p || '').startsWith('iOS') ? 'iOS'
    : (p || '').startsWith('Android') ? 'Android'
    : 'dev';

  const platforms = [...new Set((tickets || []).map(t => t.platform).filter(Boolean))];

  const checks  = (analysis.checks || []).filter(s => s && s.trim()).slice(0, 3);
  const missing = (analysis.missing_info || []).filter(s => s && s.trim()).slice(0, 3);

  // Sections are separated by a blank line so the reply is scannable.
  lines.push(`*Summary:* ${issue_summary}`);
  lines.push('');
  lines.push(`*Platform:* ${platforms.length ? platforms.join(', ') : 'Unknown'}`);
  lines.push(`*Priority:* ${sev.emoji} ${sev.label}`);
  lines.push(`*Squad:* ${squad || '_could not detect — please route manually_'}`);
  if (isBug && root_cause_hypothesis) {
    lines.push('');
    lines.push(`*Likely cause:* ${root_cause_hypothesis}`);
  }
  if (checks.length) {
    lines.push('');
    lines.push('*Worth checking first*');
    for (const c of checks) lines.push(`• ${c}`);
  }
  if (missing.length) {
    lines.push('');
    // Tag whoever posted the report — they're the one who can answer
    lines.push(reporterId ? `*Missing from the report* <@${reporterId}>` : '*Missing from the report*');
    for (const q of missing) lines.push(`• ${q}`);
  }

  // Next action — differentiated per ticket type
  lines.push('');
  lines.push(`*Next action:*`);
  const askCsFirst = missing.length ? ' — ideally after the reporter answers the questions above' : '';
  const smPc = contacts ? `${contacts.smMention} ${contacts.pcMention}` : `<!subteam^${GROUP_SM}>`;

  if (tickets?.length) {
    for (const t of tickets) {
      const role   = roleOf(t.platform);
      const action = t.summary.replace(/\[[^\]]*\]/g, '').trim(); // text after brackets
      if (t.type === 'Bug') {
        lines.push(`• ${smPc} — assign a *${role}* dev to investigate & fix "${action}"${askCsFirst}`);
      } else {
        lines.push(`• ${smPc} — assign a *${role}* dev to "${action}"${askCsFirst}`);
      }
    }
  } else {
    lines.push(`• ${smPc} — review this thread and decide next action`);
  }

  return lines.join('\n');
}

// Ticket reply — used by create card: compact confirmation
function buildTicketReply(createdJiras) {
  const lines = [];
  for (const { jira, ticket, assigneeSlackIds, uploadedCount } of createdJiras) {
    const typeEmoji    = ticket.summary.includes('Fix data') ? '🔧' : ticket.type === 'Task' ? '📋' : '🐛';
    const assigneeLine = assigneeSlackIds.length
      ? assigneeSlackIds.map(id => `<@${id}>`).join(', ')
      : '_unassigned_';
    const attachLine = uploadedCount > 0 ? ` · 📎 ${uploadedCount} file(s)` : '';
    lines.push(`${typeEmoji} <${jira.url}|${jira.key}> — ${ticket.summary}`);
    lines.push(`   Assignee: ${assigneeLine} · Sprint: Active${attachLine}`);
  }
  lines.push('');
  lines.push(`_I'll follow up with the assignee, tag SM at QA Ready, and tag PC at QA Success._`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// FOLLOW-UP SYSTEM
// ─────────────────────────────────────────────

/*
  followUpStore shape:
  {
    channelId,          Slack channel ID
    threadTs,           parent message timestamp
    jiraKey,            e.g. "UP-12345"
    jiraUrl,            full Jira URL
    squad,              squad name (for SM/PC lookup)
    lastStatus,         last Jira status observed
    lastStatusAt,       epoch ms when status last changed
    lastPingAt,         epoch ms when we last posted a message
    notifiedQaReady,    bool — SM already tagged for QA Ready
    done,               bool — stop tracking
  }
*/

// ── Get Jira issue: status + assignee in one call ──
async function getJiraIssueDetails(issueKey) {
  try {
    const res = await axios.get(
      `${JIRA_HOST}/rest/api/3/issue/${issueKey}?fields=status,assignee,fixVersions,updated,summary`,
      { headers: { Authorization: jiraAuth(), Accept: 'application/json' } }
    );
    const fields = res.data?.fields || {};
    const details = {
      status:          (fields.status?.name || '').toLowerCase(),
      statusName:      fields.status?.name || '',
      assigneeEmail:   fields.assignee?.emailAddress || null,
      assigneeDisplay: fields.assignee?.displayName || null,
      summary:         fields.summary || '',
      updatedMs:       fields.updated ? Date.parse(fields.updated) : null,
      fixVersions:     (fields.fixVersions || []).map(v => ({
        name: v.name, released: !!v.released, releaseDate: v.releaseDate || null,
      })),
    };
    console.log(`[Bot] ${issueKey} → status="${details.status}" assignee="${details.assigneeDisplay}" email="${details.assigneeEmail}"`);
    return details;
  } catch (err) {
    console.warn(`[Bot] getJiraIssueDetails(${issueKey}) failed:`, err.message);
    return null;
  }
}

// ── Resolve Jira email → Slack user ID ────────
// Primary: users.lookupByEmail (exact, single call, requires users:read.email)
// Fallback: name search via users.list if email lookup fails
async function resolveEmailToSlackId(client, email, displayName = null) {
  // 1. Try exact email lookup first
  if (email) {
    try {
      const res = await client.users.lookupByEmail({ email: email.toLowerCase() });
      if (res.user?.id) return res.user.id;
    } catch (err) {
      if (err.data?.error !== 'users_not_found') {
        console.warn(`[Bot] lookupByEmail(${email}): ${err.data?.error || err.message}`);
      }
    }
  }

  // 2. Fallback: search by display name across all members
  if (displayName) {
    try {
      const lower = displayName.toLowerCase();
      const base  = lower.replace(/\s*\(.*?\)\s*/g, '').trim(); // strip (PC), (SM) etc.
      let cursor;
      do {
        const res = await client.users.list({ limit: 200, ...(cursor ? { cursor } : {}) });
        // EXACT matching only. Substring matching caused real damage:
        // "Thanh Tran".includes("Hanh Tran") === true, so Hanh Tran's
        // tickets pinged Thanh Tran for weeks.
        const norm = s => (s || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const target = norm(base);
        const tokens = new Set(target.split(' ').filter(Boolean));
        const match = (res.members || []).find(u => {
          if (u.deleted || u.is_bot) return false;
          const cands = [u.real_name, u.profile?.real_name, u.profile?.display_name].map(norm).filter(Boolean);
          // exact normalized equality, or identical token SETS (order-insensitive)
          return cands.some(c => c === target ||
            (c.split(' ').length === tokens.size && c.split(' ').every(t => tokens.has(t))));
        });
        if (match) {
          console.log(`[Bot] Resolved "${displayName}" by name fallback → ${match.id}`);
          return match.id;
        }
        cursor = res.response_metadata?.next_cursor;
      } while (cursor);
    } catch (_) {}
  }

  console.warn(`[Bot] Could not resolve Slack ID for email="${email}" name="${displayName}"`);
  return null;
}

// ── Thread-level announcement guard ──────────────────────────────────
// In-memory flags die with the process; the THREAD is durable. Before
// announcing a milestone, check whether we already posted it there.
// This is what actually stops repeat spam across redeploys.
async function alreadyAnnouncedInThread(client, channelId, threadTs, jiraKey, marker) {
  try {
    const replies = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 100 });
    const { user_id: botUid } = await client.auth.test();
    return (replies.messages || []).some(m =>
      (m.user === botUid || m.bot_id) &&
      (m.text || '').includes(jiraKey) &&
      (m.text || '').toLowerCase().includes(marker.toLowerCase())
    );
  } catch (err) {
    console.warn('[FollowUp] Announcement guard read failed:', err.data?.error || err.message);
    return true;   // fail CLOSED — never risk spamming when we cannot verify
  }
}

// Startup grace: suppress scheduler ANNOUNCEMENTS for the first 10 minutes
// after boot. Redeploys (we ship often) must never replay old transitions.
const _bootAt = Date.now();
function inStartupGrace() {
  const grace = parseInt(process.env.FOLLOWUP_STARTUP_GRACE_MS || '600000', 10);
  if (Date.now() - _bootAt < grace) {
    console.log('[FollowUp] Startup grace — suppressing announcement');
    return true;
  }
  return false;
}

// ── Register a thread+ticket for follow-up ────
// Called after create card, or when scanning a thread with any UP-XXXXX
function registerFollowUp({ channelId, threadTs, jiraKey, jiraUrl, squad, assigneeSlackHint = null, seedStatus = null, alreadyAnnounced = false }) {
  if (followUpStore.has(jiraKey)) return; // already tracked
  followUpStore.set(jiraKey, {
    channelId,
    threadTs,
    jiraKey,
    jiraUrl,
    assigneeSlackHint,   // Slack ID we assigned at creation — exact, no name-search ambiguity
    squad:           squad || null,
    // Seeded on rebuild with the ticket's CURRENT status so the first tick
    // after a deploy doesn't treat every long-standing status as a fresh
    // transition and re-announce it (the QA Ready spam).
    lastStatus:      seedStatus,
    lastStatusAt:    Date.now(),
    // A rebuilt ticket that is ALREADY in QA Ready was announced in a
    // previous process life — never re-tag SM for it.
    lastPingAt:      alreadyAnnounced ? Date.now() : null,
    notifiedQaReady: alreadyAnnounced,
    registeredAt:    Date.now(),       // first nudge is measured from here, never immediate
    nudgeCount:      0,                // escalates to the squad lead after repeated silence
    reporterSlackId: null,             // resolved lazily: who posted the report (fyi on milestones)
    announced:       {},               // milestone → true (qa_success, live, qa_failed)
    done:            false,
  });
  console.log(`[FollowUp] Registered ${jiraKey} (squad: ${squad || 'unknown'}${seedStatus ? `, seeded at "${seedStatus}"` : ''}${alreadyAnnounced ? ', announcements suppressed' : ''})`);
}

// ── Rebuild follow-up state from Jira (authoritative, any age) ────
// Every bot-created client-report ticket has its Slack thread link in
// the description. Query ALL open client-report tickets from Jira and
// re-register each one — works for tickets of any age, fully automatic,
// no thread re-tagging ever needed.
function extractTextAndLinks(adfNode, out) {
  if (!adfNode) return;
  if (adfNode.text) out.push(adfNode.text);
  if (adfNode.marks) for (const m of adfNode.marks) if (m.type === 'link' && m.attrs?.href) out.push(m.attrs.href);
  if (adfNode.attrs?.href) out.push(adfNode.attrs.href);
  if (Array.isArray(adfNode.content)) for (const c of adfNode.content) extractTextAndLinks(c, out);
}

async function rebuildFollowUpsFromJira() {
  const DONE_STATUSES = ['qa success', 'done', 'released', 'closed'];
  let restored = 0, startAt = 0;
  try {
    for (let page = 0; page < 4; page++) {           // up to 400 tickets
      const res = await axios.get(`${JIRA_HOST}/rest/api/3/search`, {
        params: {
          // Old client-report cards carry fixVersion 27643; cards created by the
          // unified pipeline carry the [Client Report]/[Client Request] prefix.
          jql: `project = ${JIRA_PROJECT} AND (fixVersion = 27643 OR summary ~ "\\"Client Report\\"" OR summary ~ "\\"Client Request\\"") AND statusCategory != Done ORDER BY created DESC`,
          maxResults: 100, startAt,
          fields: 'summary,status,description',
        },
        headers: { Authorization: jiraAuth(), Accept: 'application/json' },
      });
      const issues = res.data?.issues || [];
      for (const issue of issues) {
        const jiraKey = issue.key;
        if (followUpStore.has(jiraKey)) continue;
        const status = (issue.fields?.status?.name || '').toLowerCase();
        if (DONE_STATUSES.includes(status)) continue;

        const parts = [];
        extractTextAndLinks(issue.fields?.description, parts);
        const blob = parts.join(' ');
        // Slack archives URL → channel + thread ts (p1783947962832559 → 1783947962.832559)
        const m = blob.match(/slack\.com\/archives\/(C[A-Z0-9]+)\/p(\d{10})(\d{6})/);
        if (!m || !MONITORED_CHANNELS[m[1]]) continue;

        const squad = detectSquadFromKeywords(`${issue.fields?.summary || ''} ${blob}`);
        registerFollowUp({
          channelId: m[1],
          threadTs:  `${m[2]}.${m[3]}`,
          jiraKey,
          jiraUrl:   `${JIRA_HOST}/browse/${jiraKey}`,
          squad,
          seedStatus: status,                       // current status — not a new transition
          alreadyAnnounced: true,                   // rebuilt = already handled in a previous life
        });
        restored++;
      }
      startAt += issues.length;
      if (issues.length < 100) break;
    }
    console.log(`[FollowUp] Jira rebuild: re-registered ${restored} open client-report ticket(s)`);
  } catch (err) {
    console.warn('[FollowUp] Jira rebuild failed:', err.response?.status || err.message);
  }
}

// ── Rebuild follow-up state from channel history ─────────────────
// Follow-up state is in-memory: it is empty after every deploy, and
// tickets tracked by the retired Client Report Bot are unknown to this
// process. On boot we scan the last 14 days of each monitored channel,
// find threads with live, not-yet-done tickets, and re-register them —
// so follow-ups survive redeploys AND the old bot's uninstallation.
async function rebuildFollowUpsFromHistory(client) {
  const DONE_STATUSES = ['qa success', 'done', 'released', 'closed'];
  const oldest = String((Date.now() - 14 * 24 * 3600 * 1000) / 1000);
  let restored = 0;

  const textOf = (m) => {
    const parts = [m.text || ''];
    for (const att of m.attachments || []) parts.push(att.title || '', att.text || '', att.fallback || '', att.title_link || '');
    const walk = (blocks) => { for (const b of blocks || []) { if (b.text?.text) parts.push(b.text.text); if (b.url) parts.push(b.url); if (b.elements) walk(b.elements); } };
    walk(m.blocks);
    return parts.join(' ');
  };

  for (const [channelId, channelName] of Object.entries(MONITORED_CHANNELS)) {
    try {
      const history = await client.conversations.history({ channel: channelId, oldest, limit: 200 });
      for (const msg of history.messages || []) {
        if (msg.bot_id || !msg.reply_count) continue;           // parents with replies only
        try {
          const replies = await client.conversations.replies({ channel: channelId, ts: msg.ts, limit: 100 });
          let jiraKey = null, squad = null;
          const combined = [];
          for (const r of replies.messages || []) {
            const t = textOf(r);
            combined.push(t);
            if (!jiraKey) { const mm = t.match(/UP-\d+/); if (mm) jiraKey = mm[0]; }
            if (!squad && r.bot_id) {
              const sm = t.match(/(?:Squad|Related squad):\s*\*?([^*\n]+?)\*?\s*$/m);
              if (sm) squad = sm[1].trim();
            }
          }
          if (!jiraKey || followUpStore.has(jiraKey)) continue;

          const details = await getJiraIssueDetails(jiraKey);
          if (!details) continue;                                // deleted ticket
          if (DONE_STATUSES.includes((details.status || '').toLowerCase())) continue;

          if (!squad) squad = detectSquadFromKeywords(combined.join(' '));
          registerFollowUp({
            channelId, threadTs: msg.ts, jiraKey, jiraUrl: `${JIRA_HOST}/browse/${jiraKey}`, squad,
            seedStatus: details.status || null,
            alreadyAnnounced: true,
          });
          restored++;
        } catch (_) {}
      }
    } catch (err) {
      console.warn(`[FollowUp] History rebuild failed for #${channelName}:`, err.data?.error || err.message);
    }
  }
  console.log(`[FollowUp] Rebuilt tracking for ${restored} open ticket(s) from channel history`);
}

// ── Scan thread for any UP-XXXXX links (bot or manual) ──
async function scanThreadForTickets(client, channelId, threadTs) {
  try {
    const messages = (await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 })).messages || [];
    const keys = new Set();
    for (const msg of messages) {
      const matches = (msg.text || '').match(/UP-\d+/g) || [];
      matches.forEach(k => keys.add(k));
    }
    return [...keys].map(k => ({ key: k, url: `${JIRA_HOST}/browse/${k}` }));
  } catch { return []; }
}

// ── Claude thread assessment before any follow-up action ──
// hoursSinceAssigneeReply is calculated in CODE before calling — not left to Claude's judgement
async function assessThreadBeforeFollowUp(threadContext, jiraKey, jiraStatus, assigneeDisplay, hoursSinceAssigneeReply) {
  const timeContext = hoursSinceAssigneeReply === null
    ? 'Assignee has never replied in this thread.'
    : hoursSinceAssigneeReply < 1
    ? 'Assignee replied less than 1 hour ago.'
    : hoursSinceAssigneeReply < 48
    ? `Assignee replied ${Math.round(hoursSinceAssigneeReply)} hours ago.`
    : `Assignee last replied ${Math.round(hoursSinceAssigneeReply / 24)} days ago — this is considered STALE.`;

  const raw = (await aiCall(
    `You are QA Agent for Everfit. Decide whether to ping the dev assignee.

Jira ticket: ${jiraKey}
Jira status: ${jiraStatus}
Assignee: ${assigneeDisplay || 'unassigned'}
Timing: ${timeContext}

RULE — if assignee replied less than 48 hours ago → ALWAYS return "skip".
RULE — if assignee replied 48+ hours ago or never replied → return "ping_dev" UNLESS the thread shows the issue is resolved.
RULE — if thread shows issue is resolved (CS confirmed, coach said fixed, etc.) → return "close".

Return ONLY valid JSON:
{
  "action": "ping_dev | skip | close",
  "reason": "1 sentence"
}`,
    `Thread (with timestamps):\n\n${threadContext}`,
    300, true
  )).replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(raw);
  } catch {
    return { action: 'skip', reason: 'Could not parse assessment — defaulting to skip' };
  }
}

// ── Calculate hours since assignee's last reply in thread ──
async function hoursSinceAssigneeReply(client, channelId, threadTs, assigneeSlackId) {
  if (!assigneeSlackId) return null;
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    const messages = result.messages || [];
    // Find the most recent message from the assignee
    const assigneeMessages = messages
      .filter(m => m.user === assigneeSlackId)
      .map(m => parseFloat(m.ts) * 1000);
    if (!assigneeMessages.length) return null;
    const lastReplyMs = Math.max(...assigneeMessages);
    return (Date.now() - lastReplyMs) / (60 * 60 * 1000);
  } catch { return null; }
}
// ─────────────────────────────────────────────

// ── Follow-up intelligence helpers ───────────────────────────────────
// Working time only: Mon–Fri, FOLLOWUP_HOUR_START–END, Vietnam time.
// Cadences are in WORKING hours, so a card created Friday 17:00 is not
// "48h old" on Monday morning.
const FOLLOWUP_CADENCE_BH = parseFloat(process.env.FOLLOWUP_CADENCE_BH || '18');   // 2 working days (9h/day)
const ESCALATE_AFTER_NUDGES = parseInt(process.env.FOLLOWUP_ESCALATE_AFTER || '2', 10);

function businessHoursBetween(startMs, endMs) {
  if (!startMs || endMs <= startMs) return 0;
  const startH = parseInt(process.env.FOLLOWUP_HOUR_START || '9', 10);
  const endH   = parseInt(process.env.FOLLOWUP_HOUR_END   || '18', 10);
  const STEP = 15 * 60 * 1000;
  let minutes = 0;
  for (let t = startMs; t < endMs; t += STEP) {
    const vn = new Date(t + 7 * 3600 * 1000);          // VN = UTC+7
    const d = vn.getUTCDay(), h = vn.getUTCHours();
    if (d !== 0 && d !== 6 && h >= startH && h < endH) minutes += 15;
  }
  return minutes / 60;
}

// Release state from the ticket's fix versions:
//   'none-needed' → fixVersion is N/A: no release, the fix is live once verified
//   'released'    → every real fix version is released
//   'pending'     → at least one real fix version is not released yet
//   'unset'       → no fix version at all
function releaseState(fixVersions) {
  const vs = fixVersions || [];
  if (!vs.length) return { state: 'unset', versions: [] };
  if (vs.every(v => /^n\s*\/?\s*a$/i.test((v.name || '').trim()))) return { state: 'none-needed', versions: vs };
  const real = vs.filter(v => !/^n\s*\/?\s*a$/i.test((v.name || '').trim()));
  const pending = real.filter(v => !v.released);
  return pending.length ? { state: 'pending', versions: pending } : { state: 'released', versions: real };
}

function describeVersions(vs) {
  return vs.map(v => `*${v.name}*${v.releaseDate ? ` (${v.releaseDate})` : ''}`).join(', ');
}

// Who reported it = the author of the thread's first message (not a bot).
async function resolveReporter(client, item) {
  if (item.reporterSlackId !== null) return item.reporterSlackId || null;
  try {
    const parent = (await client.conversations.replies({ channel: item.channelId, ts: item.threadTs, limit: 1 })).messages?.[0];
    item.reporterSlackId = parent && !parent.bot_id ? (parent.user || '') : '';
  } catch (_) { item.reporterSlackId = ''; }
  return item.reporterSlackId || null;
}

const fyi = (...ids) => {
  const uniq = [...new Set(ids.filter(Boolean))];
  return uniq.length ? `\n_fyi ${uniq.join(' ')}_` : '';
};

function startFollowUpScheduler(client) {
  const THIRTY_MIN   = 30 * 60 * 1000;
  const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;

  setInterval(async () => {
    if (!followUpStore.size) return;
    console.log(`[FollowUp] Scheduler tick — ${followUpStore.size} tracked ticket(s)`);

    // Proactive follow-ups are suppressed outside Mon–Fri working hours —
  // status changes are still picked up on the next business-hours tick.
  if (!isBusinessTime()) {
    const vn = nowVN();
    console.log(`[FollowUp] Outside business hours (VN ${vn.getUTCHours()}:${String(vn.getUTCMinutes()).padStart(2, '0')}, day ${vn.getUTCDay()}) — skipping this tick`);
    return;
  }

  for (const [jiraKey, item] of followUpStore.entries()) {
      if (item.done) { followUpStore.delete(jiraKey); continue; }

      try {
        // ── 1. Get fresh Jira status + assignee ──────
        const details = await getJiraIssueDetails(jiraKey);
        if (!details) continue;

        const { status, assigneeEmail, assigneeDisplay } = details;

        // Track status changes
        if (status !== item.lastStatus) {
          console.log(`[FollowUp] ${jiraKey} status changed: ${item.lastStatus} → ${status}`);
          item.lastStatus   = status;
          item.lastStatusAt = Date.now();
          item.nudgeCount   = 0;          // progress resets escalation
        }

        // ── 2. Resolve assignee Slack ID: email (exact) → creation hint → name search ──
        // Name search is last resort only: ambiguous names (two "Thanh Tran"s)
        // have pinged the wrong person before.
        let assigneeSlackId = assigneeEmail ? await resolveEmailToSlackId(client, assigneeEmail, null) : null;
        if (!assigneeSlackId && item.assigneeSlackHint) assigneeSlackId = item.assigneeSlackHint;
        if (!assigneeSlackId && assigneeDisplay) assigneeSlackId = await resolveEmailToSlackId(client, null, assigneeDisplay);
        const assigneeMention = assigneeSlackId
          ? `<@${assigneeSlackId}>`
          : assigneeDisplay ? `*${assigneeDisplay}*` : '_unassigned_';

        // ── 3. Who to talk to ─────────────────────────
        // Squad may be unknown for cards created outside the old module —
        // infer it from the ticket summary so SM/PC can still be tagged.
        if (!item.squad) item.squad = detectSquadFromKeywords(details.summary || '') || null;
        const contacts   = item.squad ? resolveContactMentions(getSquadContacts(item.squad)) : null;
        const smMention  = contacts?.smMention || `<!subteam^${GROUP_SM}>`;
        const pcMention  = contacts?.pcMention || null;
        const reporterId = await resolveReporter(client, item);
        const reporter   = reporterId ? `<@${reporterId}>` : null;
        const rel        = releaseState(details.fixVersions);
        const link       = `<${item.jiraUrl}|${jiraKey}>`;
        const post = (text) => client.chat.postMessage({ channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false, text });

        // Milestone guard: announce once per process life AND once per thread
        // (the thread survives redeploys; memory doesn't).
        item.announced = item.announced || {};
        const once = async (key, marker, { threadCheck = true } = {}) => {
          if (item.announced[key] || inStartupGrace()) return false;
          if (threadCheck && await alreadyAnnouncedInThread(client, item.channelId, item.threadTs, jiraKey, marker)) {
            item.announced[key] = true;
            return false;
          }
          return true;
        };
        const tellReporter = reporter ? `${reporter}, you` : 'CS, you';

        // ── 4. Branch by status + release state ───────
        const isTerminal = ['done', 'released', 'closed'].includes(status);
        const isVerified = status === 'qa success' || isTerminal;

        if (isVerified) {
          // Fix Version N/A = no release: the fix is live as soon as it's verified.
          if (rel.state === 'none-needed' || (isTerminal && rel.state === 'unset')) {
            if (await once('live', 'is live')) {
              await post(`${link} passed QA and is live — no release needed. ${tellReporter} can update the coach/client and close the Intercom ticket.` + fyi(pcMention));
              item.announced.live = true;
            }
            item.done = true; continue;
          }
          if (rel.state === 'released') {
            if (await once('live', 'is live')) {
              await post(`${link} is live in ${describeVersions(rel.versions)}. ${tellReporter} can update the coach/client and close the Intercom ticket.` + fyi(pcMention));
              item.announced.live = true;
            }
            item.done = true; continue;
          }
          if (rel.state === 'pending') {
            // Verified but not shipped: the coach can't see it yet. Say when,
            // then keep watching the release and announce again when it's out.
            if (await once('qa_success', 'passed QA')) {
              await post(`${link} passed QA. It ships with ${describeVersions(rel.versions)}, so it isn't live for the coach yet — I'll post here when that release is out.` + fyi(reporter, pcMention));
              item.announced.qa_success = true;
            }
            continue;
          }
          // Verified with no Fix Version: nobody can tell when it goes live.
          if (await once('qa_success', 'passed QA')) {
            await post(`${link} passed QA, but it has no Fix Version, so I can't tell when it goes live. ${pcMention || smMention}, please set the Fix Version (or *N/A* if no release is needed).` + fyi(reporter));
            item.announced.qa_success = true;
          }
          continue;
        }

        // QA failed → back to the dev; a new QA Ready round will be announced again.
        if (/qa fail|reopen|reject/.test(status)) {
          const key = `qa_failed_${item.lastStatusAt}`;
          if (!item.announced[key] && !inStartupGrace()) {
            await post(`${link} *failed QA*. ${assigneeMention}, please take another look — QA's notes are on the ticket.` + fyi(smMention));
            item.announced[key] = true;
            item.qaRound = (item.qaRound || 0) + 1;
            item.notifiedQaReady = false;
            item.lastPingAt = Date.now();
          }
          continue;
        }

        // QA Ready → SM assigns a QA member; reporter gets a heads-up.
        if (status === 'qa ready') {
          const round = item.qaRound || 0;
          if (!item.notifiedQaReady && await once(`qa_ready_${round}`, 'QA Ready', { threadCheck: round === 0 })) {
            await post(`${link} is *QA Ready*. ${smMention}, please assign a QA member to verify it.` + fyi(reporter));
            item.announced[`qa_ready_${round}`] = true;
            item.lastPingAt = Date.now();
            item.notifiedQaReady = true;
          } else if (!inStartupGrace()) {
            item.notifiedQaReady = true;
          }
          continue;
        }

        // ── Dev stages: To Do / In Progress / In Review ──
        const DEV_STATUSES = ['to do', 'in progress', 'in review'];
        if (!DEV_STATUSES.includes(status)) continue;

        // The clock starts at the latest sign of life — registration, status
        // change, our last nudge, or ANY update on the Jira ticket — and
        // counts WORKING hours only. A new card is never nudged in its first
        // two working days.
        const since = Math.max(item.registeredAt || 0, item.lastStatusAt || 0, item.lastPingAt || 0, details.updatedMs || 0);
        const workedHours = businessHoursBetween(since, Date.now());
        if (workedHours < FOLLOWUP_CADENCE_BH) continue;

        // ── Read the thread before nudging ─────────────
        const threadContext = await getThread(client, item.channelId, item.threadTs);
        const hoursStale    = await hoursSinceAssigneeReply(client, item.channelId, item.threadTs, assigneeSlackId);
        // The thread read is a refinement, not a gate: if the AI step fails, the
        // working-hours cadence already makes a nudge safe to send.
        let assessment;
        try {
          assessment = await assessThreadBeforeFollowUp(threadContext, jiraKey, status, assigneeDisplay, hoursStale);
        } catch (err) {
          console.warn(`[FollowUp] ${jiraKey} thread assessment failed (${err.message}) — nudging anyway`);
          assessment = { action: 'ping', reason: 'assessment unavailable' };
        }
        console.log(`[FollowUp] ${jiraKey} (${status}, ${workedHours.toFixed(1)} working h quiet): ${assessment.action} — ${assessment.reason}`);
        if (assessment.action === 'close') { item.done = true; continue; }
        if (assessment.action === 'skip') { item.lastPingAt = Date.now(); continue; }   // recent activity → restart the clock

        item.nudgeCount = (item.nudgeCount || 0) + 1;
        // Report the true age in the current status, not time since the last reminder
        const inStatusSince = Math.max(item.registeredAt || 0, item.lastStatusAt || 0);
        const days = Math.max(2, Math.floor(businessHoursBetween(inStatusSince, Date.now()) / 9));
        const escalate = item.nudgeCount > ESCALATE_AFTER_NUDGES;

        let pingText;
        if (status === 'to do') {
          pingText = `${assigneeMention}, ${link} is assigned to you and still *To Do* after ${days} working days. When do you plan to start?`;
        } else if (status === 'in progress') {
          pingText = `${assigneeMention}, checking in on ${link} (*In Progress*, no update for ${days} working days). Any ETA or blockers?`;
        } else {
          pingText = `${assigneeMention}, ${link} has been *In Review* for ${days} working days. Once it's approved, please move it to *QA Ready* so QA can pick it up.`;
        }
        // Repeated silence → loop in the squad lead
        if (escalate) pingText += `\n_No response after ${item.nudgeCount - 1} reminders — fyi ${smMention}_`;

        await post(pingText);
        item.lastPingAt = Date.now();

      } catch (err) {
        console.error(`[FollowUp] Error processing ${jiraKey}:`, err.message);
      }
    }
  }, THIRTY_MIN);
}

// ── findOrRegisterTracked — used by @QA Bot followup command ──
async function findOrRegisterTracked(client, channelId, threadTs, botBotId, botUserId) {
  // 1. Check in-memory store first
  const fromStore = [...followUpStore.values()].find(
    item => item.threadTs === threadTs && item.channelId === channelId
  );
  if (fromStore) return fromStore;

  // 2. Scan thread for any Jira ticket (bot-created or manually posted)
  try {
    const messages = (await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 })).messages || [];
    let jiraKey = null, jiraUrl = null, squad = null;

    // Find first UP-XXXXX in any message
    for (const msg of messages) {
      const match = (msg.text || '').match(/UP-\d+/);
      if (match) {
        jiraKey = match[0];
        jiraUrl = `${JIRA_HOST}/browse/${jiraKey}`;
        break;
      }
    }
    if (!jiraKey) return null;

    // Try to detect squad from thread text
    const fullText = messages.map(m => m.text || '').join(' ');
    squad = detectSquadFromKeywords(fullText);

    registerFollowUp({ channelId, threadTs, jiraKey, jiraUrl, squad });
    return followUpStore.get(jiraKey);
  } catch { return null; }
}

// ─────────────────────────────────────────────
// MAIN EVENT HANDLER (@QA Bot commands)
// ─────────────────────────────────────────────

// ── Agent status: live progress message that updates through phases ──
// Gives the "an agent is working" feel: one message posted immediately,
// edited as work progresses, deleted when the real reply lands.
// ── Lean ticket drafting for DIRECTED creates ────────────────────────
// The full analyzeThread mega-prompt (squad rubric, severity narrative,
// platform rules, both templates, analysis schema) exists for
// auto-analysis. For explicit "create card" commands it made the smart
// model grind for minutes on the gateway. This is the core-style lean
// draft: small prompt, same ticket shape, squad/severity backfilled by
// code. 5-10x faster, same downstream pipeline.
async function draftTicketsLean(context, slackThreadUrl, userDirective) {
  const system = `You draft Jira tickets from an Everfit Slack support thread. Return ONLY JSON:
{"severity":"Low|Medium|High|Critical","tickets":[{"summary":"...","type":"Bug|Task","platform":"iOS Client|iOS Coach|Android Client|Android Coach|Web|API","assignee_names":[],"description":"..."}]}

RULES:
- summary: "[Client Report|Request][<platform>][<Feature>] Clear English title" — <=100 chars. Broken behavior → Bug + "Client Report"; data fix/config/account/enable/export/request → Task + "Request".
- description (markdown, real newlines):
  Bug: ## Bug Description / ## Report Info (- **Reported by:** name+email, - **Intercom:** url if any, - **Severity:** X — why) / ## Root Cause / ## Expected Behavior / ## Steps to Reproduce
  Task: ## Context / ## Report Info (same bullets) / ## Requirements (numbered, **bold labels**)
  Build them from the thread's actual details. Do NOT include the Slack thread link.
- TICKET COUNT: one reported problem → 1 ticket. Multiple distinct issues, or the directive asks per-issue/N tickets → one ticket per issue (up to 6). Never collapse distinct issues into one generic ticket.
- English only. Never invent facts.`;
  const user = `REQUESTER DIRECTIVE (obey this): ${userDirective}\n\nSlack thread:\n\n${(context || '').substring(0, 7000)}`;
  const raw = (await aiCall(system, user, 4000, true, 'gpt-4o')).trim();
  let parsed;
  try {
    parsed = JSON.parse(raw.substring(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch (e) {
    throw new Error(`lean draft JSON parse failed: ${e.message}`);
  }
  parsed.severity = ['Low', 'Medium', 'High', 'Critical'].includes(parsed.severity) ? parsed.severity : 'Medium';
  parsed.tickets = (parsed.tickets || []).slice(0, 6).map(t => {
    const norm = normalizeTicketSummary(t, parsed);
    // squad backfilled by keyword detection — no need to burden the prompt
    norm.squad = norm.squad || detectSquadFromKeywords(`${norm.summary} ${norm.description || ''} ${context.substring(0, 2000)}`);
    norm.slackThreadUrl = slackThreadUrl;
    return norm;
  });
  if (!parsed.tickets.length) throw new Error('lean draft returned no tickets');
  return parsed;
}

// ── AI intent router: understand natural language commands ──
// Lets people talk to the bot naturally in English or Vietnamese instead
// of memorizing exact command prefixes.
async function interpretCommand(rawText) {
  const cleaned = rawText.replace(/<@[A-Z0-9]+>/g, '@member').trim().substring(0, 400);
  try {
    const raw = (await aiCall(
      `You route messages for QA Agent in Everfit bug-report channels. Users write in English or Vietnamese.
Classify the message into exactly ONE action. Return ONLY JSON: {"action":"<action>"}

Actions:
- "analyze": analyze/summarize/triage the issue ("what's wrong here", "phân tích", "check this issue", "what do you think")
- "create_card": create a Jira ticket/card without naming an assignee ("tạo card", "log this", "make a ticket", "lên card giúp em")
- "assign": create/assign a ticket TO specific @member(s) ("giao cho @member", "assign @member fix this", "@member handle giúp", "nhờ @member fix")
- "reassign": change assignee of an EXISTING ticket ("reassign", "đổi người", "chuyển qua @member", "change assignee")
- "followup": ask ticket status/progress ("status?", "tới đâu rồi", "any update?", "sao rồi", "check tiến độ")
- "troubleshoot": ask for CS troubleshooting steps ("how to fix", "hướng dẫn xử lý", "steps to try")
- "cancel": stop follow-up pings ("stop reminding", "đừng ping nữa", "cancel tracking", "done tracking")
- "weekly_report": generate the weekly summary ("weekly report", "báo cáo tuần", "run report")
- "retract": user asks the BOT to delete/remove its own previous message ("delete this response", "xóa tin nhắn đó", "remove your reply")
- "task": work whose OUTPUT IS A SLACK MESSAGE and is NONE of the above — NEVER choose "task" when the user wants cards/tickets created or assigned (that is create_card or assign, even combined with other words like "review and create cards") — summarize, extract/list items, draft a message/reply/announcement, translate, compare, review, write documentation ("tóm tắt thread", "summary all items", "draft a reply to the coach", "translate this for CS")
- "unknown": greetings, thanks, or anything else

JSON only, no other text.`,
      cleaned, 50, true, 'gpt-4o'
    )).trim();
    const parsed = JSON.parse(raw.substring(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const valid = ['analyze', 'create_card', 'assign', 'reassign', 'followup', 'troubleshoot', 'cancel', 'weekly_report', 'task', 'retract'];
    return valid.includes(parsed.action) ? parsed.action : 'unknown';
  } catch { return 'unknown'; }
}

const crMentionHandler = async ({ event, client, logger }) => {
  if (!MONITORED_CHANNELS[event.channel]) return;

  // Ticket creation is handled by the core pipeline (index.js) in ALL
  // channels — one prompt, one mechanism, no parity drift. This module
  // keeps what it uniquely owns: auto-analysis, follow-ups, weekly
  // reports, troubleshooting, reassignment, retraction.
  if (isCreationRequest(event.text) || isDiscoveryRequest(event.text)
      || /^(status|health|are you (alive|ok|up)|ping)\b/i.test((event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim())) {
    logger.info('[Bot] Creation/discovery request → deferring to core pipeline');
    return;
  }

  const { user_id: botUserId, bot_id: botBotId } = await client.auth.test();
  const triggerText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();

  // Fast path: exact command prefixes (no AI cost, instant)
  const isAnalyze        = /^(analyze|analysis|phân tích|phan tich)/.test(triggerText);
  const isWeeklyReport   = /^(weekly report|weekly|báo cáo tuần)/.test(triggerText);
  // Broad creation-language fast-path (parity with the core handler):
  // 'create a product task…', 'log 3 bugs…', 'assign to @X' must NEVER be
  // reinterpreted by the AI router as a summary/task.
  const isCreateCard     =
    /^(force\s?log|create\s?(card|ticket)|log\s?(bug|this)|assign\s?to)/.test(triggerText) ||
    FASTPATH.creation.test(event.text) ||
    FASTPATH.assignMention.test(event.text);
  const isRetract        = FASTPATH.retract.test(event.text);
  const isFollowup       = /^(followup|follow[- ]up|check\s?status|update)/.test(triggerText)
                        || FASTPATH.followup.test(event.text);
  const isTroubleshoot   = /^(troubleshoot|trouble\s?shoot|debug|how\s?to\s?fix)/.test(triggerText);
  const isCancel         = /^(cancel|stop|close)/.test(triggerText);
  const isChangeAssignee = /^(reassign|change\s?assignee|assign\s?this\s?to|move\s?to)/.test(triggerText);
  const matchedFastPath  = isAnalyze || isWeeklyReport || isCreateCard || isFollowup || isTroubleshoot || isCancel || isChangeAssignee || isRetract;

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  try {
    // Smart path: natural language → AI intent classification.
    // Understands anything: "giao cho Huy fix giúp em", "log this and give
    // it to backend", "tới đâu rồi?", "đừng nhắc nữa", "làm report tuần" ...
    let aiAction = null;
    if (!matchedFastPath) {
      aiAction = await interpretCommand(event.text);
      logger.info(`[Bot] AI router: "${triggerText.substring(0, 60)}" → ${aiAction}`);
    }

    const agentSt = agentStatus(client, event.channel, event.thread_ts || event.ts);

    const doAnalyze  = isAnalyze        || aiAction === 'analyze';
    const doWeekly   = isWeeklyReport   || aiAction === 'weekly_report';
    const doCreate   = isCreateCard     || aiAction === 'create_card' || aiAction === 'assign';
    const doFollowup = isFollowup       || aiAction === 'followup';
    const doTrouble  = isTroubleshoot   || aiAction === 'troubleshoot';
    const doCancel   = isCancel         || aiAction === 'cancel';
    const doReassign = isChangeAssignee || aiAction === 'reassign';
    const aiWantsAssign = aiAction === 'assign' || triggerText.startsWith('assign to');

    if (isRetract || aiAction === 'retract') {
      try {
        const deleted = await retractOwnMessages(client, event.channel, event.thread_ts || event.ts, event.text, { beforeTs: event.ts });
        if (!deleted) {
          await client.chat.postMessage({
            channel: event.channel, thread_ts: event.thread_ts || event.ts, unfurl_links: false,
            text: "I don't have a message of mine in this thread to delete.",
          });
        } else {
          logger.info(`[Bot] Retracted ${deleted} own message(s)`);
        }
      } catch (err) {
        logger.warn('[Bot] Retract failed:', err.data?.error || err.message);
        await client.chat.postMessage({
          channel: event.channel, thread_ts: event.thread_ts || event.ts, unfurl_links: false,
          text: `I couldn't delete it (${err.data?.error || err.message}) — a workspace admin can remove it via the message's ⋮ menu.`,
        });
      }
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      return;
    }

    if (aiAction === 'task') {
      const taskSt = agentStatus(client, event.channel, event.thread_ts || event.ts);
      await taskSt.start('⏳ _QA Agent is working on it…_');
      const crRequest = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      let threadCtx = event.thread_ts ? await getThread(client, event.channel, event.thread_ts).catch(() => '') : '';
      let crMaxChars = 12000;
      const { detectChannelScope, parseWindowDays, gatherChannelContext } = require('./lib');
      if (detectChannelScope(crRequest)) {
        const days = parseWindowDays(crRequest);
        await taskSt.update(`\ud83d\udcda _QA Agent is reading this channel's threads from the last ${days} days\u2026_`);
        const gathered = await gatherChannelContext(client, event.channel, { days });
        if (gathered.note) {
          await taskSt.done();
          await client.chat.postMessage({ channel: event.channel, thread_ts: event.thread_ts || event.ts, unfurl_links: false, text: gathered.note });
          await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
          return;
        }
        if (gathered.context) { threadCtx = gathered.context; crMaxChars = 30000; }
      }
      let result = null;
      try {
        result = (await aiCall(
          `You are QA Agent, Everfit's autonomous QA assistant in Slack bug-report channels. A teammate tagged you with a work request. Do the work fully and directly — summarize, extract/list items, draft messages or replies, translate, compare, review, analyze — whatever they asked.
Rules: Output in ENGLISH only. Use Slack formatting (*bold*, • bullets), no markdown headers. Refer to people by the names in the transcript — NEVER raw Slack IDs. Deliver the work product itself with no preamble. If the thread lacks information, give the best partial result and state what's missing. Never invent ticket numbers, links, or facts.`,
          `Transcript (may contain MULTIPLE threads from the channel, plus a LIVE JIRA STATUS section — treat that section as the current source of truth):\n${(threadCtx || '(no thread)').substring(0, crMaxChars)}\n\nRequest: ${crRequest}`,
          1800, false, 'gpt-4o'
        )).trim();
      } catch (err) { logger.warn('[Bot] Task work failed:', err.message); }
      result = require('./lib').slackify(result);
      await taskSt.done();
      await agentSt.done();
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts || event.ts, unfurl_links: false,
        text: result || "I couldn't complete that from what's in this thread — give me a bit more detail on what you need.",
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      return;
    }

    if (!doAnalyze && !doWeekly && !doCreate && !doFollowup && !doTrouble && !doCancel && !doReassign) {
      // Conversational fallback — answer directly like an assistant instead
      // of dumping a help menu. Uses thread context when available.
      const threadCtx = event.thread_ts ? await getThread(client, event.channel, event.thread_ts).catch(() => '') : '';
      const question  = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      let reply = null;
      try {
        reply = (await aiCall(
          `You are QA Agent, Everfit's autonomous bug-triage assistant living in Slack bug-report channels. Speak in first person, like a capable colleague — never refer to yourself as a bot. You can: analyze issues, create Jira cards, assign devs, check ticket status, run weekly reports, give CS troubleshooting steps, and stop follow-up tracking — teammates trigger these by telling you naturally (e.g. "log this and assign to @Huy", "status?").

Answer the user's message conversationally and helpfully in ENGLISH only, 1-5 sentences. Ground your answer in the thread context when relevant (you may reference what people said, suggest which squad/platform the issue belongs to, or give a technical opinion). If they greet you or ask what you can do, respond warmly and summarize your abilities in one line. If they ask something you truly cannot help with, say so briefly. Never invent ticket numbers or statuses.`,
          `Thread context:\n${(threadCtx || '(no thread — mentioned directly in channel)').substring(0, 3000)}\n\nUser message: ${question}`,
          400, false, 'gpt-4o'
        )).trim();
        await agentSt.done();
  } catch (err) {
    try { await agentSt.done(); } catch (_) {} logger.warn('[Bot] Chat fallback failed:', err.message); }
      reply = require('./lib').slackify(reply);

      await agentSt.done();
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts || event.ts, unfurl_links: false,
        text: reply || `Just tell me what you need in plain English or Vietnamese — e.g. _"log this and assign to @Huy"_, _"status?"_, _"tạo card giúp em"_, _"weekly report"_.`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'speech_balloon', timestamp: event.ts }).catch(() => {});
      return;
    }

    const threadTs       = event.thread_ts || event.ts;
    const slackThreadUrl = buildSlackThreadUrl(event.channel, threadTs);
    const context = event.thread_ts
      ? await getThread(client, event.channel, event.thread_ts)
      : event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!context || context.trim().length < 10) {
      await agentSt.done();
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: '👋 Tag me *inside a bug thread* so I can read the full conversation.',
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // ANALYZE — re-run analysis on demand
    // ═══════════════════════════════════════════
    if (doAnalyze) {
      await agentSt.start('⏳ _Dispatching to QA Agent — analyzing this thread…_');
      logger.info('[Bot] Analyze triggered manually');
      const { analysis, degraded } = await analyzeWithBudget(context, slackThreadUrl);
      if (!analysis) {
        await agentSt.done();
        const t = degradedAnalysisText(degraded);
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, unfurl_links: false, text: t, blocks: analysisBlocks(t, event.channel, threadTs) });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }
      const squad    = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);
      const contacts = resolveContactMentions(squad ? getSquadContacts(squad) : null);
      // The reporter is whoever started the thread (not whoever typed 'analyze')
      let reporterId = null;
      try {
        const parent = (await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 1 })).messages?.[0];
        if (parent && !parent.bot_id) reporterId = parent.user || null;
      } catch (_) {}
      await agentSt.done();
      const manualReply = buildAnalysisReply(analysis, squad, contacts, reporterId);
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs, unfurl_links: false,
        text: manualReply,
        blocks: analysisBlocks(manualReply, event.channel, threadTs),
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'mag_right', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // WEEKLY REPORT — manual trigger
    // ═══════════════════════════════════════════
    if (doWeekly) {
      await agentSt.start('⏳ _Dispatching to QA Agent — compiling the weekly report…_');
      logger.info('[Bot] Manual weekly report triggered');
      try { await client.reactions.add({ channel: event.channel, name: 'bar_chart', timestamp: event.ts }); } catch (_) {}
      await sendWeeklyReport(client);
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // CANCEL
    // ═══════════════════════════════════════════
    if (doCancel) {
      const tracked = await findOrRegisterTracked(client, event.channel, threadTs, botBotId, botUserId);
      if (!tracked) {
        await agentSt.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: "I'm not tracking anything in this thread yet — say _\"create card\"_ or _\"follow up\"_ on a ticket and I'll start." });
      } else {
        tracked.done = true;
        await agentSt.done();
      await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `🛑 Follow-up cancelled for <${tracked.jiraUrl}|${tracked.jiraKey}>. Please keep the ticket updated in Jira.`,
        });
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      }
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // CHANGE ASSIGNEE
    // ═══════════════════════════════════════════
    if (doReassign) {
      const mentionedUsers = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
        .map(m => m.replace(/<@|>/g, '')).filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id));

      if (!mentionedUsers.length) {
        await agentSt.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `Who should take it? Mention them — e.g. _"reassign to @person"_ — and I'll update the ticket.` });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      const specificKey = (event.text.match(/UP-\d+/i) || [])[0]?.toUpperCase();
      const threadMsgsCA = (await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 50 }).catch(() => ({ messages: [] }))).messages || [];
      const threadKeys = [];
      for (const msg of [...threadMsgsCA].reverse()) {
        if (msg.bot_id !== botBotId) continue;
        for (const k of (msg.text || '').match(/UP-\d+/g) || []) {
          if (!threadKeys.includes(k)) threadKeys.push(k);
        }
      }

      if (!threadKeys.length) {
        await agentSt.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: "I couldn't find any Jira ticket in this thread to reassign. Create one first with _\"create card\"_." });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (threadKeys.length > 1 && !specificKey) {
        const list = threadKeys.map(k => `• <${JIRA_HOST}/browse/${k}|${k}>`).join('\n');
        await agentSt.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `This thread has several tickets — which one should I reassign?\n${list}\nTell me like: _"reassign to @person ${threadKeys[0]}"_` });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      const targetKey = (specificKey && threadKeys.includes(specificKey)) ? specificKey : threadKeys[0];
      const newJiraId = await resolveJiraAccountId(client, mentionedUsers[0]);
      if (!newJiraId) {
        await agentSt.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `I couldn't match <@${mentionedUsers[0]}> to a Jira account, so I've left the assignee unchanged — please set it in Jira, or give me someone else.` });
      } else {
        await axios.put(`${JIRA_HOST}/rest/api/3/issue/${targetKey}/assignee`, { accountId: newJiraId }, {
          headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
        });
        const tracked = followUpStore.get(targetKey);
        if (tracked) tracked.assigneeSlackIds = [mentionedUsers[0]];
        await agentSt.done();
      await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text: `✅ <${JIRA_HOST}/browse/${targetKey}|${targetKey}> reassigned to <@${mentionedUsers[0]}>.`,
        });
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      }
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // FOLLOW-UP (manual trigger)
    // ═══════════════════════════════════════════
    if (doFollowup) {
      await agentSt.start('⏳ _QA Agent is checking ticket status…_');

      // ── Mention-aware follow-up ───────────────────────────────────
      // "follow up with @Thanh Tran until his task is finished" must
      // track THAT person's ticket and ping THAT person — not the first
      // ticket in the thread and not its current Jira assignee.
      const mentionedIds = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
        .map(m => m.replace(/<@|>/g, ''))
        .filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id));

      if (mentionedIds.length) {
        const targetId = mentionedIds[0];
        let targetEmail = null, targetName = null;
        try {
          const info = await client.users.info({ user: targetId });
          targetEmail = info.user?.profile?.email || null;
          targetName  = info.user?.real_name || null;
        } catch (_) {}

        const threadTickets = await scanThreadForTickets(client, event.channel, threadTs);
        const threadKeys = (threadTickets || []).map(t => (typeof t === 'string' ? t : t.key)).filter(Boolean);

        // An explicit ticket key in the request wins over any matching
        // ("do follow up with @Hanh for UP-79009").
        const explicitKey = (event.text.match(/\bUP-\d+\b/i) || [])[0]?.toUpperCase() || null;

        const matches = [];
        for (const key of (explicitKey ? [explicitKey] : threadKeys).slice(0, 12)) {
          const d = await getJiraIssueDetails(key);
          if (!d) continue;
          if (explicitKey) { matches.push({ key, details: d }); continue; }   // user named the ticket
          const nrm = s => (s || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
          const sameEmail = targetEmail && d.assigneeEmail && d.assigneeEmail.toLowerCase() === targetEmail.toLowerCase();
          const sameName  = targetName && d.assigneeDisplay && nrm(d.assigneeDisplay) === nrm(targetName);
          if (sameEmail || sameName) matches.push({ key, details: d });
        }

        const done = s => ['qa success', 'done', 'released', 'closed'].includes((s || '').toLowerCase());
        const open = matches.filter(m => !done(m.details.status));
        const chosen = open.length ? open : matches;

        await agentSt.done();
        if (!chosen.length) {
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs, unfurl_links: false,
            text: threadKeys.length
              ? `I couldn't find a ticket in this thread assigned to <@${targetId}> (I checked ${threadKeys.slice(0, 6).map(k => `<${JIRA_HOST}/browse/${k}|${k}>`).join(', ')}). Tell me the ticket key and I'll track it.`
              : `There's no Jira ticket in this thread yet — say _"create card"_ and I'll log one, then I can track it.`,
          });
        } else {
          const lines = [];
          for (const { key, details } of chosen.slice(0, 5)) {
            registerFollowUp({
              channelId: event.channel, threadTs, jiraKey: key,
              jiraUrl: `${JIRA_HOST}/browse/${key}`, squad: null,
              assigneeSlackHint: targetId,        // ping the person actually mentioned
              seedStatus: details.status, alreadyAnnounced: true,
            });
            const t = followUpStore.get(key);
            if (t) { t.assigneeSlackHint = targetId; t.done = false; }
            lines.push(`🔎 <${JIRA_HOST}/browse/${key}|${key}> — *${details.status}*`);
          }
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs, unfurl_links: false,
            text:
              `Tracking <@${targetId}>'s ticket${lines.length > 1 ? 's' : ''} until closed:\n${lines.join('\n')}\n` +
              `_I'll nudge <@${targetId}> every 2 business days (Mon–Fri, working hours) and tag SM at QA Ready._`,
          });
        }
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
        return;
      }

      const tracked = await findOrRegisterTracked(client, event.channel, threadTs, botBotId, botUserId);

      // ── No ticket yet → tag SM/PC to review and assign ──
      if (!tracked) {
        const squad    = detectSquadFromKeywords(context);
        const contacts = resolveContactMentions(squad ? getSquadContacts(squad) : null);

        const smPcMention = contacts
          ? `${contacts.smMention} ${contacts.pcMention}`
          : `<!subteam^${GROUP_SM}>`;

        await agentSt.done();
      await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text:
            `📋 No Jira ticket has been created for this thread yet.\n` +
            `${smPcMention} — please review this issue and either:\n` +
            `• Create a ticket: just say \`create card\`\n` +
            `• Or assign directly to a dev member once created`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Get fresh Jira state
      const details = await getJiraIssueDetails(tracked.jiraKey);
      const status = details?.status || 'unknown';
      const assigneeSlackId = await resolveEmailToSlackId(client, details?.assigneeEmail, details?.assigneeDisplay);
      const assigneeMention = assigneeSlackId
        ? `<@${assigneeSlackId}>`
        : details?.assigneeDisplay ? `*${details.assigneeDisplay}*` : null;
      const contacts = tracked.squad
        ? resolveContactMentions(getSquadContacts(tracked.squad))
        : null;

      // ── No assignee → tag SM/PC to assign a dev ──
      if (!assigneeMention) {
        const smPcMention = contacts
          ? `${contacts.smMention} ${contacts.pcMention}`
          : `<!subteam^${GROUP_SM}>`;
        await agentSt.done();
      await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text:
            `⚠️ <${tracked.jiraUrl}|${tracked.jiraKey}> has no dev assigned yet (*${status}*).\n` +
            `${smPcMention} — please assign this ticket to the right dev member.`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Scan thread and ask Claude before doing anything
      const hoursStale = await hoursSinceAssigneeReply(client, event.channel, threadTs, assigneeSlackId);
      const assessment = await assessThreadBeforeFollowUp(
        context, tracked.jiraKey, status, details?.assigneeDisplay, hoursStale
      );
      console.log(`[FollowUp] Manual: ${tracked.jiraKey} → ${assessment.action} (assignee last replied: ${hoursStale === null ? 'never' : Math.round(hoursStale) + 'h ago'}) — ${assessment.reason}`);

      if (assessment.action === 'close' || ['done', 'released', 'closed'].includes(status)) {
        tracked.done = true;
        await agentSt.done();
      await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `✅ <${tracked.jiraUrl}|${tracked.jiraKey}> appears resolved. Closing follow-up tracking.`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (status === 'qa success') {
        const pcMention = contacts?.pcMention || `<!subteam^${GROUP_SM}>`;
        await agentSt.done();
      await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text:
            `✅ <${tracked.jiraUrl}|${tracked.jiraKey}> has passed QA!\n` +
            `${pcMention} — please let CS know so they can follow up with the coach/client and close the Intercom ticket.`,
        });
        tracked.done = true;
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (status === 'qa ready') {
        const smMention = contacts?.smMention || `<!subteam^${GROUP_SM}>`;
        await agentSt.done();
      await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text:
            `🧪 <${tracked.jiraUrl}|${tracked.jiraKey}> is *QA Ready*.\n` +
            `${smMention} — please assign a QA member to verify this ticket.`,
        });
        tracked.notifiedQaReady = true;
        tracked.lastPingAt = Date.now();
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (assessment.action === 'skip') {
        await agentSt.done();
      await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `ℹ️ <${tracked.jiraUrl}|${tracked.jiraKey}> is *${status}* — ${assessment.reason} No ping sent.`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
        return;
      }

      // ping_dev — status-specific message
      let pingText;
      if (status === 'to do') {
        pingText =
          `👋 ${assigneeMention} — <${tracked.jiraUrl}|${tracked.jiraKey}> is assigned to you and still *To Do*.\n` +
          `Could you acknowledge and let us know when you plan to start?`;
      } else if (status === 'in progress') {
        pingText =
          `👋 ${assigneeMention} — checking in on <${tracked.jiraUrl}|${tracked.jiraKey}> (*In Progress*).\n` +
          `Any updates, ETA, or blockers?`;
      } else if (status === 'in review') {
        pingText =
          `👋 ${assigneeMention} — <${tracked.jiraUrl}|${tracked.jiraKey}> is *In Review*.\n` +
          `Is the review complete? Please move to *QA Ready* when done so QA can pick it up.`;
      } else {
        pingText =
          `👋 ${assigneeMention} — following up on <${tracked.jiraUrl}|${tracked.jiraKey}> (*${status}*).\n` +
          `Any updates or blockers?`;
      }

      await agentSt.done();
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs, unfurl_links: false,
        text: pingText,
      });
      tracked.lastPingAt = Date.now();
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // TROUBLESHOOT
    // ═══════════════════════════════════════════
    if (doTrouble) {
      await agentSt.start('⏳ _QA Agent is preparing troubleshooting steps…_');
      const reply = await aiCall(
        `You are QA Agent for Everfit. Provide practical troubleshooting steps for the CS team to try BEFORE escalating to dev. CS are non-technical — steps must be clear and specific.

Format:
🔍 *Troubleshooting suggestions* — [Platform detected]

*What CS should check first:*
1. <check>

*Ask the coach/client to try:*
1. <step>

*If still not resolved — collect before escalating:*
- <info item>

Max 8 steps total. Plain English only.`,
        `Thread:\n\n${context}`,
        1000
      );

      await agentSt.done();
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `<!subteam^${GROUP_CS}> here are troubleshooting steps to try before escalating:\n\n${reply}`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'mag', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // CREATE CARD
    // No re-analysis — auto-analyze already posted the report.
    // Just create the ticket(s) and post a short confirmation.
    // ═══════════════════════════════════════════

    // Check for existing tickets (dedup protection)
    const allThreadMsgs = (await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 50 }).catch(() => ({ messages: [] }))).messages || [];
    const existingKeys = [];
    const existingSummaries = [];
    for (const msg of allThreadMsgs) {
      if (msg.bot_id !== botBotId) continue;
      (msg.text || '').match(/UP-\d+/g)?.forEach(k => { if (!existingKeys.includes(k)) existingKeys.push(k); });
      const sm = (msg.text || '').match(/\*(.+?)\*/);
      if (sm) existingSummaries.push(sm[1].toLowerCase());
    }

    // Run analysis to get ticket details
    logger.info('[Bot] Create card — analyzing thread...');
    await agentSt.start('⏳ _Dispatching to QA Agent — reading the thread…_');
    await agentSt.update('🧠 _QA Agent is analyzing and drafting the ticket(s)…_');
    const tDraft = Date.now();
    let analysis;
    try {
      analysis = await draftTicketsLean(context, slackThreadUrl, event.text.replace(/<@[A-Z0-9]+>/g, '').trim());
      logger.info(`[Bot] Lean draft: ${analysis.tickets.length} ticket(s) in ${((Date.now() - tDraft) / 1000).toFixed(1)}s`);
    } catch (err) {
      logger.warn(`[Bot] Lean draft failed after ${((Date.now() - tDraft) / 1000).toFixed(1)}s:`, err.message);
      if (/timed out/i.test(err.message)) {
        // Both models timed out — chaining into the heavier full analysis
        // would just double the death. Tell the truth instead.
        await agentSt.done();
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text: `The AI endpoint timed out twice while drafting (${err.message}). Nothing was created — try again in a moment; if it keeps happening, the Railway logs now show exactly which model is stalling.`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }
      analysis = await analyzeThread(context, slackThreadUrl, event.text.replace(/<@[A-Z0-9]+>/g, '').trim());
      logger.info(`[Bot] Full analysis fallback done in ${((Date.now() - tDraft) / 1000).toFixed(1)}s total`);
    }
    await agentSt.update('📝 _QA Agent is creating the Jira card(s)…_');
    logger.info(`[Bot] Severity=${analysis.severity} · tickets=${analysis.tickets.length}`);

    // Honor explicit issue type ("create a product task…") and explicit
    // parent ("under this parent UP-x") from the request — same semantics
    // as the core handler.
    try {
      const availableTypes = await require('./lib').getProjectIssueTypes();
      const explicitType = availableTypes
        .filter(t => !/^(bug|task)$/i.test(t))
        .sort((a, b) => b.length - a.length)
        .find(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(event.text));
      const parentMatch = event.text.match(/\b(?:epic|under|parent)\s+(?:this\s+)?(?:epic\s+|parent\s+)?(UP-\d+)\b/i);
      for (const t of analysis.tickets) {
        if (explicitType) t.type = explicitType;
        if (parentMatch) t.explicitParent = parentMatch[1].toUpperCase();
      }
      if (explicitType || parentMatch) logger.info(`[Bot] Explicit overrides: type=${explicitType || '-'} parent=${parentMatch ? parentMatch[1] : '-'}`);
    } catch (_) {}

    const squad = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);

    // Parse trigger: direct assignees vs cc/fyi (cc'd members are NEVER assigned)
    const { assignees: triggerAssignees, ccIds } = parseAssigneesFromTrigger(event.text, botUserId);
    // "assign to me" / "giao cho em|mình|tôi" (no @mention) → the requester
    if (!triggerAssignees.length && /\b(assign|giao)\b[^.<\n]{0,30}\b(to\s+)?(me|myself|em|mình|tôi)\b/i.test(event.text)) {
      triggerAssignees.push(event.user);
      logger.info('[Bot] Self-assign detected → assigning to requester');
    }
    if (ccIds.length) logger.info(`[Bot] cc/fyi mentions excluded from assignment: ${ccIds.join(', ')}`);

    // Validate that thread tickets still exist in Jira (they may have been deleted)
    const liveKeys = [];
    for (const key of existingKeys) {
      if (await getJiraIssueDetails(key)) liveKeys.push(key);
      else logger.info(`[Bot] ${key} found in thread but no longer exists in Jira — ignoring`);
    }
    if (!liveKeys.length && existingKeys.length) {
      // All previous tickets deleted → allow re-creation, don't dedup against dead summaries
      existingSummaries.length = 0;
    }

    // Keys the requester referenced in the command itself (e.g. "under epic
    // UP-51189", "duplicate of UP-123") are context, NOT duplicate signals.
    const referencedInTrigger = new Set((event.text.match(/\b(?:UP|PLAN)-\d+\b/gi) || []).map(k => k.toUpperCase()));
    const dedupKeys = liveKeys.filter(k => !referencedInTrigger.has(k));

    // Shortcut: "assign to @X" when a LIVE ticket already exists
    if (aiWantsAssign && liveKeys.length && triggerAssignees.length) {
      const targetKey = liveKeys[0];
      const newJiraId = await resolveJiraAccountId(client, triggerAssignees[0]);
      if (newJiraId) {
        try {
          await axios.put(`${JIRA_HOST}/rest/api/3/issue/${targetKey}/assignee`, { accountId: newJiraId }, {
            headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
          });
          await agentSt.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, unfurl_links: false, text: `✅ <${JIRA_HOST}/browse/${targetKey}|${targetKey}> reassigned to <@${triggerAssignees[0]}>.` });
        } catch (err) {
          await agentSt.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, unfurl_links: false, text: `I tried to update <${JIRA_HOST}/browse/${targetKey}|${targetKey}> but Jira refused (${err.response?.status || err.message}). Please assign manually while I keep tracking it.` });
        }
      } else {
        await agentSt.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `I couldn't match <@${triggerAssignees[0]}> to a Jira account — the card is created but unassigned. Please set the assignee in Jira, or tell me someone else.` });
      }
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      return;
    }

    // Dedup — skipped entirely on "force log" (user explicitly wants new tickets)
    const isForce = /\bforce\s?log\b/i.test(event.text);
    const newTickets = isForce ? analysis.tickets : analysis.tickets.filter(ticket => {
      const isDupe = existingSummaries.some(existing => {
        const existingWords = new Set(existing.split(/\s+/).filter(w => w.length > 4));
        return ticket.summary.toLowerCase().split(/\s+/).filter(w => w.length > 4).filter(w => existingWords.has(w)).length >= 3;
      });
      if (isDupe) logger.info(`[Bot] Skipping duplicate: ${ticket.summary}`);
      return !isDupe;
    });

    if (!newTickets.length) {
      await agentSt.done();
      const guardKeys = dedupKeys.length ? dedupKeys : liveKeys;
      const keyLinks  = guardKeys.map(k => `<${JIRA_HOST}/browse/${k}|${k}>`).join(', ');
      const value     = JSON.stringify({ c: event.channel, t: threadTs, x: event.text.substring(0, 1100) });
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs, unfurl_links: false,
        text: `This thread already has ${keyLinks} — what should I do?`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `This thread already has ${keyLinks}.\nThreads often cover several issues — tell me how to proceed:` } },
          { type: 'actions', elements: [
            { type: 'button', style: 'primary', action_id: 'qa_cr_dup_remaining', value,
              text: { type: 'plain_text', text: '🧩 Cover remaining issues', emoji: true } },
            { type: 'button', action_id: 'qa_cr_dup_force', value,
              text: { type: 'plain_text', text: '🆕 Log new ticket anyway', emoji: true } },
            { type: 'button', action_id: 'qa_cr_dup_follow', value,
              text: { type: 'plain_text', text: '🔍 Follow up on existing', emoji: true } },
            { type: 'button', style: 'danger', action_id: 'qa_cr_dup_cancel', value,
              text: { type: 'plain_text', text: '✖️ Cancel', emoji: true } },
          ] },
        ],
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Expand tickets by assignee ─────────────────
    // Jira assignee is a single picker:
    //   "assign to @A cc @B"  → 1 card, assigned to A only
    //   "assign to @A @B"     → 2 cards, one per assignee
    //   no direct assignee    → AI-detected name or platform recommendation
    // Each card's platform is corrected to the assignee's role:
    // e.g. bug reported on Web but assigned to a BE member → [API] prefix.
    const ticketJobs = []; // { ticket, assigneeSlackId }

    if (triggerAssignees.length > 0) {
      for (const ticket of newTickets) {
        for (const assigneeId of triggerAssignees) {
          const family   = await getMemberPlatformFamily(client, assigneeId);
          const adjusted = applyPlatformToTicket(ticket, family);
          if (family && adjusted.platform !== ticket.platform) {
            logger.info(`[Bot] Platform corrected for <@${assigneeId}> (${family}): ${ticket.platform} → ${adjusted.platform}`);
          }
          ticketJobs.push({ ticket: adjusted, assigneeSlackId: assigneeId });
        }
      }
    } else {
      for (const ticket of newTickets) {
        let assigneeSlackId = null;
        if (ticket.assignee_names?.length) {
          const ids = (await Promise.all(ticket.assignee_names.map(n => findSlackUserByName(client, n)))).filter(id => id && !ASSIGNEE_BLOCKLIST.has(id));
          assigneeSlackId = ids[0] || null;
        }
        if (!assigneeSlackId) {
          const recommended = getRecommendedAssignee(ticket.squad || squad, ticket.platform);
          assigneeSlackId   = recommended ? await findSlackUserByName(client, recommended) : null;
        }
        // Correct platform for AI/roster-resolved assignees too
        if (assigneeSlackId) {
          const family   = await getMemberPlatformFamily(client, assigneeSlackId);
          ticketJobs.push({ ticket: applyPlatformToTicket(ticket, family), assigneeSlackId });
        } else {
          ticketJobs.push({ ticket, assigneeSlackId: null });
        }
      }
    }

    const sprintId          = await getActiveSprintId();
    const tAtt = Date.now();
    const threadAttachments = await getAllThreadAttachments(client, event.channel, threadTs);
    // Download each file ONCE — previously every ticket re-downloaded every file
    for (const att of threadAttachments) {
      try { att.buffer = await downloadSlackFile(att.url); }
      catch (err) { logger.warn(`[Bot] Attachment download failed (${att.name}):`, err.message); }
    }
    logger.info(`[Bot] Attachments ready: ${threadAttachments.filter(a => a.buffer).length}/${threadAttachments.length} in ${((Date.now() - tAtt) / 1000).toFixed(1)}s`);
    const createdJiras      = [];

    for (const { ticket, assigneeSlackId } of ticketJobs) {
      const jiraId = assigneeSlackId ? await resolveJiraAccountId(client, assigneeSlackId) : null;
      const jira   = await createJiraIssue({ ...ticket, severity: analysis.severity }, jiraId ? [jiraId] : []);
      if (sprintId) await addIssueToSprint(jira.key, sprintId);

      let uploadedCount = 0;
      for (const att of threadAttachments) {
        try {
          const buf = att.buffer;
          if (!buf) continue;
          if (await uploadAttachmentToJira(jira.key, att.name, buf, att.mimetype)) uploadedCount++;
        } catch (_) {}
      }

      registerFollowUp({
        channelId: event.channel,
        threadTs,
        jiraKey: jira.key,
        jiraUrl: jira.url,
        squad:   ticket.squad || squad,
        assigneeSlackHint: assigneeSlackId || null,
      });

      createdJiras.push({ jira, ticket, assigneeSlackIds: assigneeSlackId ? [assigneeSlackId] : [], uploadedCount });
    }

    // Short ticket confirmation only — no re-analysis
    await agentSt.done();
      await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text: buildTicketReply(createdJiras),
    });

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});

  } catch (err) {
    logger.error('[Bot] Unhandled error:', err.response?.data ?? err.message);
    await agentSt.done();
      await client.chat.postMessage({
      channel: event.channel, thread_ts: event.thread_ts || event.ts,
      text: `I hit an error and couldn't finish: \`${err.message}\`\nTry again in a moment — my logs have the details.`,
    });
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
  }
};
slackApp.event('app_mention', withWatchdog('mention', crMentionHandler, 150000,
  `I couldn't finish this in time and stopped. Please try again in a moment.`));

// ── Duplicate-guard button actions ───────────────────────────────────
// Buttons re-invoke the full mention pipeline with a synthetic event, so
// every capability (multi-ticket, assignment, status animation) applies.
async function crRunSynthetic(client, logger, payload, text, clickerId) {
  const syntheticEvent = { channel: payload.c, thread_ts: payload.t, ts: payload.t, user: clickerId, text };
  await crMentionHandler({ event: syntheticEvent, client, logger });
}

function dupPayload(body) {
  try { return JSON.parse(body.actions[0].value); } catch { return null; }
}

async function markChoice(client, body, line) {
  try {
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: line, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: line } }],
    });
  } catch (_) {}
}

slackApp.action('qa_cr_dup_force', async ({ ack, body, client, logger }) => {
  await ack();
  const p = dupPayload(body); if (!p) return;
  await markChoice(client, body, `🆕 <@${body.user.id}> chose *log a new ticket anyway* — on it.`);
  await crRunSynthetic(client, logger, p, `force log ${p.x}`, body.user.id);
});

slackApp.action('qa_cr_dup_remaining', async ({ ack, body, client, logger }) => {
  await ack();
  const p = dupPayload(body); if (!p) return;
  await markChoice(client, body, `🧩 <@${body.user.id}> chose *cover remaining issues* — checking what's already ticketed.`);
  const covered = [];
  try {
    const found = await scanThreadForTickets(client, p.c, p.t);
    for (const key of (found || []).slice(0, 8)) {
      const d = await getJiraIssueDetails(key);
      if (d) covered.push(`${key} — ${d.summary || ''}`.trim());
    }
  } catch (_) {}
  const directive =
    `force log ${p.x}\n` +
    `IMPORTANT: Create tickets ONLY for issues discussed in this thread that are NOT already covered by an existing ticket. ` +
    `Already covered (do NOT recreate these): ${covered.length ? covered.join(' | ') : 'unknown — compare against ticket titles found in the thread'}. ` +
    `If every issue is already covered, return an empty tickets array.`;
  await crRunSynthetic(client, logger, p, directive, body.user.id);
});

slackApp.action('qa_cr_dup_follow', async ({ ack, body, client, logger }) => {
  await ack();
  const p = dupPayload(body); if (!p) return;
  const lines = [];
  try {
    const found = await scanThreadForTickets(client, p.c, p.t);
    for (const key of (found || []).slice(0, 8)) {
      const d = await getJiraIssueDetails(key);
      if (!d) continue;
      const done = ['qa success', 'done', 'released', 'closed'].includes((d.status || '').toLowerCase());
      lines.push(`${done ? '✅' : '🔎'} <${JIRA_HOST}/browse/${key}|${key}> — *${d.status}*${d.assigneeDisplay ? ` · ${d.assigneeDisplay}` : ''}`);
      if (!done) registerFollowUp({ channelId: p.c, threadTs: p.t, jiraKey: key, jiraUrl: `${JIRA_HOST}/browse/${key}`, squad: null });
    }
  } catch (_) {}
  await markChoice(client, body,
    lines.length
      ? `🔍 <@${body.user.id}> chose *follow up on existing*:\n${lines.join('\n')}\n_I'm tracking the open ones — I'll follow up every 2 business days until closed._`
      : `🔍 I couldn't find live tickets in this thread anymore.`);
});

slackApp.action('qa_cr_dup_cancel', async ({ ack, body, client }) => {
  await ack();
  await markChoice(client, body, `✖️ <@${body.user.id}> cancelled — nothing created.`);
});

// ─────────────────────────────────────────────
// AUTO-ANALYZE — fires on every new thread in monitored channels
// ─────────────────────────────────────────────

// Watchdog wrapper: no client-report handler may run forever. On timeout
// the status is cleared and the thread gets an honest note instead of a
// permanent 'I'm analyzing the report'.
function withWatchdog(name, handler, budgetMs, note = null) {
  return async (args) => {
    const { event, client, logger } = args;
    let finished = false;
    const timer = setTimeout(async () => {
      if (finished) return;
      logger.warn(`[Bot] WATCHDOG ${name} exceeded ${budgetMs / 1000}s`);
      try {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: event.thread_ts || event.ts, unfurl_links: false,
          text: note || `I couldn't finish analyzing this in time — tag me with _"analyze"_ to retry, or just describe what you need.`,
        });
      } catch (_) {}
    }, budgetMs);
    try { await handler(args); }
    finally { finished = true; clearTimeout(timer); }
  };
}

const autoAnalysisHandler = withWatchdog('auto-analysis', async ({ event, client, logger }) => {
  // Only monitored channels
  if (!MONITORED_CHANNELS[event.channel]) return;

  // Only new parent messages — skip replies, edits, deletes, bot messages.
  // IMPORTANT: 'file_share' is a normal new message WITH attachments
  // (how CS posts reports with screenshots) — must NOT be skipped.
  if (event.subtype && event.subtype !== 'file_share') return;
  if (event.bot_id) return;           // any bot
  if (event.thread_ts && event.thread_ts !== event.ts) return; // reply

  // Skip if message is too short to be a real report —
  // unless it has attachments (screenshot + short caption is a valid report)
  const text     = (event.text || '').trim();
  const hasFiles = Array.isArray(event.files) && event.files.length > 0;
  if (text.length < 20 && !hasFiles) {
    logger.info(`[Bot] Auto-analyze skipped (short text, no files): "${text.substring(0, 40)}"`);
    return;
  }

  // Skip bare @mentions (handled by app_mention)
  if (/^<@[A-Z0-9]+>(\s+\w+)?$/.test(text)) return;

  try {
    logger.info(`[Bot] Auto-analyzing new thread in ${MONITORED_CHANNELS[event.channel]}`);
    await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});

    const status = agentStatus(client, event.channel, event.ts);
    await status.start('⏳ _Dispatching to QA Agent…_');

    const slackThreadUrl = buildSlackThreadUrl(event.channel, event.ts);
    const context = text;

    await status.update('🧠 _QA Agent is analyzing the report…_');
    const { analysis, degraded } = await analyzeWithBudget(context, slackThreadUrl);
    if (!analysis) {
      await status.done();
      const t = degradedAnalysisText(degraded);
      await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, unfurl_links: false, text: t, blocks: analysisBlocks(t, event.channel, event.ts) });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }
    logger.info(`[Bot] Auto-analyze: Severity=${analysis.severity}`);

    const squad    = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);
    const contacts = resolveContactMentions(squad ? getSquadContacts(squad) : null);

    const replyText = buildAnalysisReply(analysis, squad, contacts, event.user || null);
    await status.done();
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      unfurl_links: false,
      text: replyText,
      blocks: analysisBlocks(replyText, event.channel, event.ts),
    });

    // Auto-register any existing UP-XXXXX in this thread for follow-up
    // (covers manually-created Jira tickets pasted in the thread)
    const existingTickets = await scanThreadForTickets(client, event.channel, event.ts);
    for (const { key, url } of existingTickets) {
      registerFollowUp({ channelId: event.channel, threadTs: event.ts, jiraKey: key, jiraUrl: url, squad });
    }

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'mag_right', timestamp: event.ts }).catch(() => {});

  } catch (err) {
    logger.error('[Bot] Auto-analyze error:', err.message);
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
  }
}, 150000);
slackApp.event('message', autoAnalysisHandler);

// ─────────────────────────────────────────────
// WEEKLY REPORT SCHEDULER
// Every Monday 9 AM VN — reads last week's threads from all 3 channels
// ─────────────────────────────────────────────

let lastWeeklyReportDate = null;

// ── Last week Mon 00:00 → Sun 23:59 in Unix seconds (VN UTC+7) ──
function getLastWeekTimestamps() {
  const now       = nowVN();
  const dayOfWeek = now.getUTCDay(); // 0=Sun … 6=Sat
  // Days back to last week's Monday
  const daysToThisMon  = (dayOfWeek + 6) % 7;       // days to this week's Mon
  const daysToLastMon  = daysToThisMon + 7;           // days to last week's Mon
  const lastMonMs = now.getTime() - daysToLastMon * 86400000;
  // Zero out to 00:00 VN (subtract the time-of-day portion)
  const lastMonMidnightMs = lastMonMs - (lastMonMs % 86400000);
  const lastSunMidnightMs = lastMonMidnightMs + 7 * 86400000- 1000; // Sun 23:59:59
  return {
    oldest:     String(Math.floor((lastMonMidnightMs - 7 * 3600000) / 1000)), // convert VN→UTC
    latest:     String(Math.floor((lastSunMidnightMs - 7 * 3600000) / 1000)),
    labelStart: new Date(lastMonMidnightMs),
    labelEnd:   new Date(lastMonMidnightMs + 6 * 86400000),
  };
}

// ── Scan one channel for parent threads from last week ──
async function scanChannelThreads(client, channelId, oldest, latest) {
  const threads = [];
  let cursor;
  try {
    do {
      const res = await client.conversations.history({
        channel: channelId,
        oldest,
        latest,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const msg of res.messages || []) {
        if (msg.subtype) continue;                              // skip edits/joins
        if (msg.bot_id) continue;                              // skip bot messages
        if (msg.thread_ts && msg.thread_ts !== msg.ts) continue; // skip replies
        threads.push(msg);
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
  } catch (err) {
    console.warn(`[WeeklyReport] Error scanning ${channelId}:`, err.message);
  }
  return threads.reverse(); // chronological order
}

// ── For each thread, find linked ticket + get Jira status + squad ──
async function enrichThread(client, channelId, msg, botUserId) {
  const threadTs = msg.ts;
  let jiraKey = null, jiraUrl = null, jiraStatus = null, jiraAssignee = null, squad = null;
  let englishSummary = null, inThreadAssigneeId = null, inThreadAssigneeName = null;

  try {
    const replies = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 100 });
    const allText = [];
    const assignRe = /nhờ|help|check|assign|làm|fix|giúp|xem|handle/i;

    // Extract ALL searchable text from a message: body + attachments + blocks.
    // QA members often paste Jira links that Slack renders as unfurl
    // attachments — the UP-xxx key then lives OUTSIDE reply.text.
    const fullTextOf = (reply) => {
      const parts = [reply.text || ''];
      for (const att of reply.attachments || []) {
        parts.push(att.title || '', att.text || '', att.fallback || '', att.title_link || '', att.from_url || '');
      }
      const walkBlocks = (blocks) => {
        for (const b of blocks || []) {
          if (b.text?.text) parts.push(b.text.text);
          if (b.url) parts.push(b.url);
          if (b.elements) walkBlocks(b.elements);
          if (b.fields) for (const f of b.fields) parts.push(f.text || '');
        }
      };
      walkBlocks(reply.blocks);
      return parts.join(' ');
    };

    for (const reply of replies.messages || []) {
      const text     = reply.text || '';
      const fullText = fullTextOf(reply);
      allText.push(fullText);

      // Find first Jira ticket — anywhere in the message incl. unfurls
      if (!jiraKey) {
        const match = fullText.match(/UP-\d+/);
        if (match) { jiraKey = match[0]; jiraUrl = `${JIRA_HOST}/browse/${jiraKey}`; }
      }

      if (reply.bot_id) {
        // Extract squad from bot's analysis reply
        if (!squad) {
          const m = text.match(/(?:Squad|Related squad):\s*\*?([^*\n]+?)\*?\s*$/m);
          if (m) squad = m[1].trim();
        }
        // Extract English summary from bot's analysis reply (new + old formats)
        if (!englishSummary) {
          const mNew = text.match(/\*Summary:\*\s*([^\n]+)/);
          const mOld = text.match(/Summary\*\s*\n([^\n]+)/);
          const s = (mNew?.[1] || mOld?.[1] || '').trim();
          if (s) englishSummary = s.substring(0, 120);
        }
      } else {
        // Detect in-thread assignment by a human: "@Duy Le fix data nha"
        for (const line of text.split('\n')) {
          if (/^\s*(cc|fyi)[:\s]/i.test(line)) continue;
          if (!assignRe.test(line)) continue;
          const ids = [...line.matchAll(/<@([A-Z0-9]+)>/g)]
            .map(m => m[1])
            .filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id));
          if (ids.length) inThreadAssigneeId = ids[ids.length - 1];
        }
      }
    }

    if (jiraKey) {
      const details = await getJiraIssueDetails(jiraKey);
      if (details) { jiraStatus = details.status; jiraAssignee = details.assigneeDisplay; }
    }

    if (inThreadAssigneeId) {
      try {
        const info = await client.users.info({ user: inThreadAssigneeId });
        inThreadAssigneeName = info.user?.profile?.display_name || info.user?.real_name || null;
      } catch (_) {}
    }

    // Keyword fallback if bot reply not found
    if (!squad) squad = detectSquadFromKeywords(allText.join(' ')) || 'Other';

  } catch (_) {}

  const preview = (msg.text || '')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<https?:\/\/[^\s>]+>/g, '')
    .replace(/<!subteam\^[^>]+>/g, '')
    .replace(/<@[A-Z0-9]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);

  return { threadTs, jiraKey, jiraUrl, jiraStatus, jiraAssignee, squad, preview, englishSummary, inThreadAssigneeId, inThreadAssigneeName };
}

// ── Batch-translate previews missing an English summary ──
async function translateMissingSummaries(threads) {
  const pending = threads.filter(t => !t.englishSummary && t.preview);
  if (!pending.length) return;
  try {
    const raw = (await aiCall(
      'You translate Vietnamese bug report snippets into English. For EACH input string, return ONE short English sentence (max 15 words) describing the issue. Return ONLY a JSON array of strings — same order and count as the input array. English only.',
      JSON.stringify(pending.map(t => t.preview)),
      1500
    )).replace(/```json|```/g, '').trim();
    const arr = JSON.parse(raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1));
    if (Array.isArray(arr)) {
      pending.forEach((t, i) => { if (arr[i]) t.englishSummary = String(arr[i]).substring(0, 120); });
    }
  } catch (err) {
    console.warn('[WeeklyReport] Translation failed:', err.message);
  }
}

// ── Status emoji ──────────────────────────────
function statusEmoji(status) {
  if (!status) return '⬜';
  const s = status.toLowerCase();
  if (s === 'to do')       return '⬜';
  if (s === 'in progress') return '🔵';
  if (s === 'in review')   return '🔍';
  if (s === 'qa ready')    return '🧪';
  if (s === 'qa success')  return '✅';
  if (s === 'done' || s === 'released') return '✅';
  return '❓';
}

// ── Classify thread into one of 3 work stages ──
function workStage(t) {
  if (t.jiraStatus) {
    const s = t.jiraStatus.toLowerCase();
    if (['qa success', 'done', 'released', 'closed'].includes(s)) return 'DONE';
    if (['in progress', 'in review', 'qa ready'].includes(s))     return 'IN DEVELOPMENT';
    return 'IN INVESTIGATION'; // to do
  }
  // No ticket — but if someone was asked to handle it in-thread, work is happening
  if (t.inThreadAssigneeId) return 'IN DEVELOPMENT';
  return 'IN INVESTIGATION';
}

// ── Build report for ONE channel, grouped by squad → stage ──
function buildChannelWeeklyReport(channelName, channelId, threads, weekLabel) {
  // Mentions derived from the squad roster: leads first, everyone else cc'd
  const _m = c => c.id ? `<@${c.id}>` : `*${c.email.split('@')[0]}*`;
  const _leads = new Map(), _others = new Map();
  for (const r of Object.values(SQUAD_ROSTER)) {
    (r.contacts || []).forEach((c, i) => {
      if (i === 0) _leads.set(c.email, c);
      else _others.set(c.email, c);
    });
  }
  for (const e of _leads.keys()) _others.delete(e);
  const WEEKLY_MAIN = [..._leads.values()].map(_m).join(' ');
  const WEEKLY_CC   = 'cc ' + [..._others.values()].map(_m).join(' ');

  // Clean truncation at word boundary — never cut mid-word
  const clip = (s, max = 110) => {
    if (!s) return '';
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    const cut = s.substring(0, max);
    return cut.substring(0, Math.max(cut.lastIndexOf(' '), 60)).replace(/[,.;:—-]$/, '') + '…';
  };
  const cleanName = (n) => (n || '').replace(/\s*\(\s*/g, ' (').replace(/\s*\)/g, ')').trim();

  const done        = threads.filter(t => workStage(t) === 'DONE').length;
  const dev         = threads.filter(t => workStage(t) === 'IN DEVELOPMENT').length;
  const invest      = threads.filter(t => workStage(t) === 'IN INVESTIGATION').length;
  const needsReview = threads.filter(t => !t.jiraKey && !t.inThreadAssigneeId).length;

  const lines = [];
  lines.push(WEEKLY_MAIN);
  lines.push(WEEKLY_CC);
  lines.push(`📊 *Weekly Report — #${channelName} — ${weekLabel}*`);

  if (threads.length === 0) {
    lines.push('_No reports last week._');
    return lines.join('\n');
  }

  // Headline: totals FIRST so leaders see status at a glance
  lines.push(`*${threads.length} reports* · ✅ ${done} done · 🔨 ${dev} in dev · 🔍 ${invest} investigating${needsReview ? ` · ⚠️ *${needsReview} need SM/PC review*` : ''}`);

  // Group by squad
  const bySquad = new Map();
  for (const t of threads) {
    const key = t.squad || 'Other';
    if (!bySquad.has(key)) bySquad.set(key, []);
    bySquad.get(key).push(t);
  }

  const SQUAD_ORDER = [
    'Core Product - Training & Automation',
    'Core Product - Platform Capability',
    'Core Product - Engagement',
    'Core Product - Enablement',
    'Core Product - Nutrition',
    'AI Features',
    'Payment & Billing',
    'Booking',
    'Other',
  ];
  const sortedSquads = [...bySquad.keys()].sort((a, b) => {
    const ai = SQUAD_ORDER.indexOf(a), bi = SQUAD_ORDER.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const STAGES = [
    { key: 'DONE',             emoji: '✅' },
    { key: 'IN DEVELOPMENT',   emoji: '🔨' },
    { key: 'IN INVESTIGATION', emoji: '🔍' },
  ];

  let idx = 0;
  for (const squadName of sortedSquads) {
    const squadThreads = bySquad.get(squadName);
    const shortSquad   = squadName.replace(/^Core Product - /, '');
    lines.push('');
    lines.push(`*${shortSquad}* (${squadThreads.length})`);

    const byStage = { 'DONE': [], 'IN DEVELOPMENT': [], 'IN INVESTIGATION': [] };
    for (const t of squadThreads) byStage[workStage(t)].push(t);

    for (const { key, emoji } of STAGES) {
      for (const t of byStage[key]) {
        idx++;
        const threadUrl = buildSlackThreadUrl(channelId, t.threadTs);
        const text      = clip(t.englishSummary || t.preview);

        let head;
        if (t.jiraKey) {
          const assignee = t.jiraAssignee ? ` · ${cleanName(t.jiraAssignee)}` : '';
          head = `${emoji} <${t.jiraUrl}|${t.jiraKey}> _${(t.jiraStatus || 'unknown').toLowerCase()}_${assignee}`;
        } else if (t.inThreadAssigneeName || t.inThreadAssigneeId) {
          head = `${emoji} ⏳ _No card_ — *${cleanName(t.inThreadAssigneeName) || 'a dev'}* handling in thread`;
        } else {
          head = `⚠️ *No card, no assignee — SM/PC please review*`;
        }

        lines.push(`${idx}. ${head}`);
        lines.push(`    ${text} · <${threadUrl}|thread>`);
      }
    }
  }

  return lines.join('\n');
}

// ── Send one dedicated report per channel ────
async function sendWeeklyReport(client) {
  console.log('[WeeklyReport] Scanning last week threads...');
  const { oldest, latest, labelStart, labelEnd } = getLastWeekTimestamps();

  const fmt       = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const weekLabel = `${fmt(labelStart)}–${fmt(labelEnd)}, ${labelEnd.getUTCFullYear()}`;

  const { user_id: botUserId } = await client.auth.test().catch(() => ({}));

  for (const [channelId, channelName] of Object.entries(MONITORED_CHANNELS)) {
    console.log(`[WeeklyReport] Scanning #${channelName}...`);
    const msgs    = await scanChannelThreads(client, channelId, oldest, latest);
    const threads = await Promise.all(msgs.map(msg => enrichThread(client, channelId, msg, botUserId)));
    await translateMissingSummaries(threads);
    console.log(`[WeeklyReport] #${channelName}: ${threads.length} thread(s)`);

    const message = buildChannelWeeklyReport(channelName, channelId, threads, weekLabel);
    try {
      await client.chat.postMessage({ channel: channelId, text: message, unfurl_links: false });
      console.log(`[WeeklyReport] Sent to #${channelName}`);
    } catch (err) {
      console.warn(`[WeeklyReport] Failed for #${channelName}:`, err.message);
    }
  }

  lastWeeklyReportDate = nowVN().toISOString().slice(0, 10);
}

// ── Scheduler: check every 30 min, fire Monday 9 AM VN ──
function startWeeklyReportScheduler(client) {
  setInterval(async () => {
    const vn    = nowVN();
    const day   = vn.getUTCDay();
    const hour  = vn.getUTCHours();
    const today = vn.toISOString().slice(0, 10);
    if (day !== 1) return;          // Monday only
    if (hour !== 9) return;         // 9 AM VN only
    if (lastWeeklyReportDate === today) return; // once per day
    await sendWeeklyReport(client);
  }, 30 * 60 * 1000);
}



// ─────────────────────────────────────────────
// MODULE REGISTRATION
// ─────────────────────────────────────────────
// ── Boot recovery: finish what a killed process left behind ──────────
// A deploy / OOM / crash kills in-flight work; its status message stays
// ('I'm analyzing the report') and in-memory watchdogs die with it. On
// boot, find those orphans in the monitored channels, remove them, and
// re-run the auto-analysis for reports that never got one.
async function recoverOrphanedAnalyses(client) {
  const STATUS_RE = /^_I['’]m .+_$/;
  const oldest = String((Date.now() - 3 * 3600 * 1000) / 1000);
  const { user_id: botUid } = await client.auth.test();
  const log = { info: console.log, warn: console.warn, error: console.error };
  let cleaned = 0, rerun = 0;

  for (const channelId of Object.keys(MONITORED_CHANNELS)) {
    let history;
    try { history = await client.conversations.history({ channel: channelId, oldest, limit: 50 }); }
    catch (err) { console.warn(`[Recovery] history failed for ${channelId}:`, err.data?.error || err.message); continue; }

    for (const parent of history.messages || []) {
      if (parent.bot_id || !parent.reply_count) continue;
      let replies;
      try { replies = (await client.conversations.replies({ channel: channelId, ts: parent.ts, limit: 30 })).messages || []; }
      catch (_) { continue; }
      const mine = replies.filter(m => m.user === botUid && m.ts !== parent.ts);
      const orphans = mine.filter(m => STATUS_RE.test((m.text || '').trim()));
      if (!orphans.length) continue;

      for (const o of orphans) {
        try { await client.chat.delete({ channel: channelId, ts: o.ts }); cleaned++; } catch (_) {}
      }
      const hasAnalysis = mine.some(m => (m.text || '').includes('*Summary:*'));
      const humanReplies = replies.filter(m => !m.bot_id && m.ts !== parent.ts).length;
      // Re-run only if the report never got its analysis and nobody has
      // replied since (if humans are already handling it, stay quiet).
      if (!hasAnalysis && humanReplies === 0 && rerun < 5) {
        rerun++;
        console.log(`[Recovery] Re-running auto-analysis for ${channelId}/${parent.ts}`);
        try { await autoAnalysisHandler({ event: { ...parent, channel: channelId }, client, logger: log }); }
        catch (err) { console.warn('[Recovery] re-run failed:', err.message); }
      }
    }
  }
  console.log(`[Recovery] Boot sweep done — ${cleaned} orphaned status(es) removed, ${rerun} analysis re-run(s)`);
}

function register(realApp, realOpenai) {
  openai = realOpenai;
  loadKnowledgeBase();
  hydrateRosterIds(realApp.client).catch(() => {});
  rebuildFollowUpsFromJira()
    .then(() => rebuildFollowUpsFromHistory(realApp.client))
    .catch(err => console.warn('[FollowUp] Rebuild error:', err.message));
  for (const [kind, name, handler] of _registrations) realApp[kind](name, handler);
  startFollowUpScheduler(realApp.client);
  startWeeklyReportScheduler(realApp.client);
  // Give the app a moment to finish booting, then recover interrupted work
  setTimeout(() => recoverOrphanedAnalyses(realApp.client).catch(err => console.warn('[Recovery] failed:', err.message)), 15000);
  console.log('✅ [ClientReport] module active (gpt-4o-mini) — monitoring:', Object.values(MONITORED_CHANNELS).join(', '));
}

function isTracked(jiraKey) { return followUpStore.has(jiraKey) && !followUpStore.get(jiraKey).done; }
function setTrackedAssignee(jiraKey, slackId) {
  const t = followUpStore.get(jiraKey);
  if (t && slackId) t.assigneeSlackHint = slackId;
}

module.exports = { register, MONITORED_CHANNELS, registerFollowUp, isTracked, setTrackedAssignee };
