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

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

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
  'Core Product - Training & Automation': {
    sm: 'Thanh Ngo', smId: 'U0142GU335F',
    pc: 'Duyen Tran', pcId: 'U06401J6QR4',
    ba: 'Ngoc Nguyen',
    backend: 'Dong Vo', web: 'Hanh Tran', android: 'Khoa Huynh', ios: 'Tuyen Tran', qa: 'Trang Ngo',
    domains: [
      'workout', 'training', 'exercise', 'program', 'autoflow', 'video workout',
      'task assignment', 'master planner', 'gamification', 'leaderboard',
      'studio', 'on-demand', 'sequence',
      'onboarding', 'onboarding flow', 'onboarding form', 'form', 'questionnaire',
      'form assignment', 'assignment',
    ],
  },
  'Core Product - Nutrition': {
    sm: 'Bao Ho', smId: 'U0445EQS1ED',
    pc: 'Anh Van Le', pcId: 'U04PN2RHT4K',
    ba: 'Dung Pham',
    backend: 'Dong Vo', web: 'Ha Duong', android: 'Hoai Ho', ios: 'Tan Huynh', qa: 'Thao Nguyen',
    domains: [
      'nutrition', 'meal', 'macro', 'food', 'diet', 'recipe',
      'myfitnessPal', 'cronometer', 'ingredient', 'calorie', 'meal plan',
    ],
  },
  'Core Product - Platform Capability': {
    sm: 'Thanh Ngo', smId: 'U0142GU335F',
    pc: 'Nhi Bien', pcId: 'U08J7SGJGNM',
    ba: 'Dieu Kieu',
    backend: 'Hong Tu', web: 'Nhan Huynh', android: 'Lam Bui', ios: 'Thinh Le', qa: 'Uyen Thao',
    domains: [
      'login', 'auth', 'authentication', 'permission', 'workspace',
      'localization', 'branding', 'white label', 'notification settings',
      'account settings', 'team settings', 'sign in', 'sign up', 'password',
    ],
  },
  'Core Product - Engagement': {
    sm: 'Bao Ho', smId: 'U0445EQS1ED',
    pc: 'Anh Van Le', pcId: 'U04PN2RHT4K',
    ba: 'Sally Phan',
    backend: 'Duc Trinh', web: 'Nhan Huynh', android: 'Khoa Huynh', ios: 'Thinh Le', qa: 'Bich Thuy',
    domains: [
      'message', 'chat', 'inbox', 'forum', 'community', 'checkin', 'check-in',
      'client profile', 'body metric',
      'habit', 'goal', 'referral', 'affiliate', 'broadcast',
    ],
  },
  'Core Product - Integration & Middleware': {
    sm: 'Thanh Ngo', smId: 'U0142GU335F',
    pc: 'Nhi Bien', pcId: 'U08J7SGJGNM',
    ba: 'Sally Phan',
    backend: 'Viet Mai', web: 'Nhan Huynh', qa: 'Chieu Hoang',
    domains: [
      'integration', 'webhook', 'apple health', 'garmin', 'fitbit',
      'whoop', 'zapier', 'sync', 'middleware', 'health app',
    ],
  },
  'Payment & Billing': {
    sm: 'Hoa Nguyen', smId: 'UQZ2PNPN3',
    pc: 'Tam Nguyen', pcId: 'U08R7JP31CZ',
    ba: null,
    domains: [
      'payment', 'billing', 'subscription', 'invoice', 'charge', 'refund',
      'stripe', 'paypal', 'credit card', 'plan upgrade', 'plan downgrade',
      'trial', 'renewal', 'pricing', 'receipt', 'transaction',
      'license', 'licence', 'seat', 'not eligible', 'license assignment',
      'remaining license', 'assigned license',
      'macrosnap', 'macro snap',
    ],
  },
  'AI Features': {
    sm: 'Hoa Nguyen', smId: 'UQZ2PNPN3',
    pc: 'Tam Nguyen', pcId: 'U08R7JP31CZ',
    ba: null,
    domains: [
      // General
      'ai', 'artificial intelligence', 'ai feature',
      // Training Programming
      'ai workout builder', 'ai workout generator', 'ai programming builder', 'push-up challenge',
      // Nutrition Programming
      'ai recipe builder', 'ai alternative recipe', 'ai recipe',
      // Communication
      'smart response', 'knowledge base',
      // AI Agents
      'olly', 'olly voice', 'ask olly',
      // Client Performance
      'bi dashboard', 'compare check-in',
      // Generic
      'ai suggest', 'ai generate', 'ai coach', 'ai meal', 'ai analysis', 'log food with ai',
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
const slackApp = { event: (name, handler) => _registrations.push([name, handler]) };

// ── OpenAI wrapper ──
async function aiCall(system, userContent, maxTokens = 1000, jsonMode = false) {
  const res = await openai.chat.completions.create({
    model:      'gpt-4o-mini',
    max_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: userContent },
    ],
  });
  return res.choices[0].message.content || '';
}

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

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function jiraAuth() {
  return 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
}

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
  const lines  = await Promise.all((result.messages || []).map(async msg => {
    let name = msg.username || msg.user || 'user';
    try { name = (await client.users.info({ user: msg.user })).user?.real_name || name; } catch (_) {}
    const text = (msg.text || '').replace(/<@([A-Z0-9]+)>/g, (_, uid) => `@${uid}`);
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
    const score = (roster.domains || []).filter(kw => lower.includes(kw)).length;
    if (score > bestScore) { bestScore = score; best = squad; }
  }
  return best;
}

function getSquadContacts(squad) {
  const r = SQUAD_ROSTER[squad];
  return r ? { sm: r.sm, smId: r.smId, pc: r.pc, pcId: r.pcId } : null;
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
  if (!contacts) return null;
  return {
    sm:        contacts.sm,
    pc:        contacts.pc,
    smMention: contacts.smId ? `<@${contacts.smId}>` : `*${contacts.sm}*`,
    pcMention: contacts.pcId ? `<@${contacts.pcId}>` : `*${contacts.pc}*`,
  };
}

// ─────────────────────────────────────────────

async function getAllThreadAttachments(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    const atts = [];
    for (const msg of result.messages || []) {
      for (const f of msg.files || []) {
        if (f.url_private_download) {
          atts.push({ name: f.name || 'attachment', url: f.url_private_download, mimetype: f.mimetype || 'application/octet-stream' });
        }
      }
    }
    return atts;
  } catch { return []; }
}

async function downloadSlackFile(url) {
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: 'arraybuffer',
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


async function getActiveSprintId() {
  try {
    const boardRes = await axios.get(`${JIRA_HOST}/rest/agile/1.0/board`, {
      params: { projectKeyOrId: JIRA_PROJECT, type: 'scrum' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const board = boardRes.data?.values?.[0];
    if (!board) return null;
    const sprintRes = await axios.get(`${JIRA_HOST}/rest/agile/1.0/board/${board.id}/sprint`, {
      params: { state: 'active' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const sprints = sprintRes.data?.values || [];
    // Multiple sprints can be active at once (dev sprint + "SM Review").
    // Tickets must ALWAYS go to the real Active Sprint — never SM Review.
    const eligible = sprints.filter(s => !/sm\s*review/i.test(s.name || ''));
    if (!eligible.length) return null;
    eligible.sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));
    console.log(`[Sprint] Selected active sprint: ${eligible[0].name} (${eligible[0].id})`);
    return eligible[0].id;
  } catch { return null; }
}

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
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = [];
  let last = 0, m;
  while ((m = urlRegex.exec(line)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: line.slice(last, m.index) });
    parts.push({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[1] } }] });
    last = m.index + m[1].length;
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

function buildAdfDescription(text) {
  return {
    type: 'doc', version: 1,
    content: (text || '').split('\n')
      .filter(l => l.trim())
      .map(l => ({ type: 'paragraph', content: renderLineAdf(l) })),
  };
}

async function createJiraIssue(ticket, jiraAccountIds) {
  const sevMeta = SEVERITY_META[ticket.severity] || SEVERITY_META.Medium;
  const fields = {
    project:     { key: JIRA_PROJECT },
    summary:     ticket.summary,
    issuetype:   { name: ticket.type === 'Task' ? 'Task' : 'Bug' },
    priority:    { name: sevMeta.jiraPriority },   // derived from severity
    description: buildAdfDescription(ticket.description),
    fixVersions: [{ id: '27643' }],
  };
  const parentKey = PLATFORM_PARENTS[ticket.platform];
  if (parentKey) fields.parent = { key: parentKey };
  if (jiraAccountIds.length) fields.assignee = { accountId: jiraAccountIds[0] };

  const res = await axios.post(`${JIRA_HOST}/rest/api/3/issue`, { fields }, {
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { key: res.data.key, url: `${JIRA_HOST}/browse/${res.data.key}` };
}

// ─────────────────────────────────────────────
// CORE AI ANALYSIS  ─  single Sonnet 4 call
// ─────────────────────────────────────────────

async function analyzeThread(context, slackThreadUrl) {
  // Trim KB to avoid hitting token limits while keeping the most useful sections
  const kbSection = KNOWLEDGE_BASE
    ? `\n\n---\n📚 KNOWLEDGE BASE — use patterns below to determine severity and resolution steps:\n${KNOWLEDGE_BASE.substring(0, 7000)}\n---\n`
    : '';

  const squadList = Object.keys(SQUAD_ROSTER).join('\n  - ');

  const systemPrompt = `You are QA Bot, the internal issue-triage assistant for Everfit — a B2B fitness coaching SaaS platform.

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
  - Autoflow, Onboarding Flow, onboarding forms, form assignment,
    questionnaires, task assignment
    → always route to "Core Product - Training & Automation"
  - AI Workout Builder, AI Recipe Builder, AI Alternative Recipe, Olly Voice,
    Ask Olly, Smart Response, Knowledge Base, BI Dashboard, Push-up Challenge,
    AI Workout Generator, AI Programming Builder, Compare Check-in form
    → always route to "AI Features"
  - MacroSnap, macrosnap license, license assignment, "not eligible for license",
    license seats, subscription, billing, payment, invoice, refund
    → route to "Payment & Billing"
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

TWO-TICKET RULE — create 2 tickets ONLY when BOTH are true:
  1. An immediate data/account fix is needed right now (type=Task)
  2. A code/root-cause fix is also needed (type=Bug or Task)
  Otherwise: 1 ticket only.

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
  "root_cause_hypothesis": "1-sentence hypothesis from KB patterns, or null",
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

DESCRIPTION TEMPLATE (Bug):
Slack thread: ${slackThreadUrl}
Squad: <squad>
Severity: <severity> — <rationale>

Reported by: <coach/client name or email — NOT the CS/SM who posted>
Intercom link: <URL if found, else omit this line>

Affected area: <feature or screen name>

Steps to reproduce:
1. <step>
2. <step>

Expected behavior: <what should happen>
Actual behavior: <what actually happens>

Resolution Steps:
- <step from KB pattern if applicable>
- <step>

DESCRIPTION TEMPLATE (Task / Data fix):
Slack thread: ${slackThreadUrl}
Squad: <squad>
Severity: <severity> — <rationale>

Reported by: <coach/client name or email>
Intercom link: <URL if found, else omit this line>

Request details: <clear, specific description of what needs to be done>

Resolution Steps:
- <step>
- <step>`;

  const rawResponse = await aiCall(systemPrompt, `Slack thread:\n\n${context}`, 3500, true); // jsonMode

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
      parsed.tickets = parsed.tickets.map(t => normalizeTicketSummary(t, parsed));
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
        firstLine, 60
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
function buildAnalysisReply(analysis, squad, contacts) {
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

  lines.push(`📝 *Summary:* ${issue_summary}`);
  lines.push(`📱 *Affected Platform:* ${platforms.length ? platforms.join(', ') : 'Unknown'}`);
  lines.push(`⚡ *Priority:* ${sev.emoji} ${sev.label}`);
  if (isBug && root_cause_hypothesis) {
    lines.push(`🔍 *Root cause:* ${root_cause_hypothesis}`);
  }
  lines.push(`🏢 *Related squad:* ${squad || '_could not detect — please route manually_'}`);

  // Next action — differentiated per ticket type
  lines.push('');
  lines.push(`🎯 *Next action:*`);
  const smPc = contacts ? `${contacts.smMention} ${contacts.pcMention}` : `<!subteam^${GROUP_SM}>`;

  if (tickets?.length) {
    for (const t of tickets) {
      const role   = roleOf(t.platform);
      const action = t.summary.replace(/\[[^\]]*\]/g, '').trim(); // text after brackets
      if (t.type === 'Bug') {
        lines.push(`• ${smPc} — review and assign to a *${role}* dev to investigate & fix "${action}"`);
      } else {
        lines.push(`• ${smPc} — review and assign to a *${role}* dev to "${action}"`);
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
      `${JIRA_HOST}/rest/api/3/issue/${issueKey}?fields=status,assignee`,
      { headers: { Authorization: jiraAuth(), Accept: 'application/json' } }
    );
    const fields = res.data?.fields || {};
    const details = {
      status:          (fields.status?.name || '').toLowerCase(),
      assigneeEmail:   fields.assignee?.emailAddress || null,
      assigneeDisplay: fields.assignee?.displayName || null,
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
        const match = (res.members || []).find(u => {
          const real    = (u.real_name || '').toLowerCase();
          const display = (u.profile?.display_name || '').toLowerCase();
          return real.includes(base) || display.includes(base);
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

// ── Register a thread+ticket for follow-up ────
// Called after create card, or when scanning a thread with any UP-XXXXX
function registerFollowUp({ channelId, threadTs, jiraKey, jiraUrl, squad }) {
  if (followUpStore.has(jiraKey)) return; // already tracked
  followUpStore.set(jiraKey, {
    channelId,
    threadTs,
    jiraKey,
    jiraUrl,
    squad:           squad || null,
    lastStatus:      null,
    lastStatusAt:    Date.now(),
    lastPingAt:      null,
    notifiedQaReady: false,
    done:            false,
  });
  console.log(`[FollowUp] Registered ${jiraKey} (squad: ${squad || 'unknown'})`);
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
    `You are QA Bot for Everfit. Decide whether to ping the dev assignee.

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

function startFollowUpScheduler(client) {
  const THIRTY_MIN   = 30 * 60 * 1000;
  const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;

  setInterval(async () => {
    if (!followUpStore.size) return;
    console.log(`[FollowUp] Scheduler tick — ${followUpStore.size} tracked ticket(s)`);

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
        }

        // ── 2. Resolve assignee Slack ID fresh from Jira ──
        const assigneeSlackId = await resolveEmailToSlackId(client, assigneeEmail, assigneeDisplay);
        const assigneeMention = assigneeSlackId
          ? `<@${assigneeSlackId}>`
          : assigneeDisplay ? `*${assigneeDisplay}*` : '_unassigned_';

        // ── 3. Get squad contacts ─────────────────────
        const contacts = item.squad
          ? resolveContactMentions(getSquadContacts(item.squad))
          : null;

        // ── 4. Branch by Jira status ──────────────────

        // ── Terminal: Done / Released → silent close ──
        if (['done', 'released', 'closed'].includes(status)) {
          item.done = true;
          continue;
        }

        // ── QA Success → tag PC once, then close ──────
        if (status === 'qa success') {
          const pcMention = contacts?.pcMention || `<!subteam^${GROUP_SM}>`;
          await client.chat.postMessage({
            channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false,
            text:
              `✅ <${item.jiraUrl}|${jiraKey}> has passed QA!\n` +
              `${pcMention} — please let the CS team know so they can follow up with the coach/client and close the Intercom ticket.`,
          });
          item.done = true;
          continue;
        }

        // ── QA Ready → tag SM to assign QA (once) ─────
        if (status === 'qa ready') {
          if (!item.notifiedQaReady) {
            const smMention = contacts?.smMention || `<!subteam^${GROUP_SM}>`;
            await client.chat.postMessage({
              channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false,
              text:
                `🧪 <${item.jiraUrl}|${jiraKey}> is now *QA Ready*.\n` +
                `${smMention} — please assign a QA member to verify this ticket.`,
            });
            item.notifiedQaReady = true;
            item.lastPingAt = Date.now();
          }
          continue;
        }

        // ── Dev stages: To Do / In Progress / In Review ──
        // Only ping on working days (Mon–Fri) and after 48h since last ping
        const DEV_STATUSES = ['to do', 'in progress', 'in review'];
        if (!DEV_STATUSES.includes(status)) continue;

        // Skip weekends — VN timezone (UTC+7)
        if (!isWorkingHours()) continue;
        const vnDay = nowVN().getUTCDay(); // 0=Sun, 6=Sat
        if (vnDay === 0 || vnDay === 6) continue;

        const hoursSinceLastPing = item.lastPingAt
          ? (Date.now() - item.lastPingAt) / (60 * 60 * 1000)
          : 49; // never pinged → treat as overdue

        if (hoursSinceLastPing < 48) continue;

        // ── Scan thread + ask Claude before pinging ────
        const threadContext = await getThread(client, item.channelId, item.threadTs);
        const hoursStale    = await hoursSinceAssigneeReply(client, item.channelId, item.threadTs, assigneeSlackId);
        const assessment    = await assessThreadBeforeFollowUp(
          threadContext, jiraKey, status, assigneeDisplay, hoursStale
        );

        console.log(`[FollowUp] ${jiraKey} (${status}): ${assessment.action} — ${assessment.reason}`);

        if (assessment.action === 'close') { item.done = true; continue; }
        if (assessment.action === 'skip') continue;

        // ── Status-specific ping message ───────────────
        let pingText;
        if (status === 'to do') {
          pingText =
            `👋 ${assigneeMention} — <${item.jiraUrl}|${jiraKey}> has been assigned to you and is still *To Do*.\n` +
            `Could you acknowledge this ticket and let us know when you plan to start?`;
        } else if (status === 'in progress') {
          pingText =
            `👋 ${assigneeMention} — checking in on <${item.jiraUrl}|${jiraKey}> (*In Progress*).\n` +
            `Any updates, ETA, or blockers we should know about?`;
        } else if (status === 'in review') {
          pingText =
            `👋 ${assigneeMention} — <${item.jiraUrl}|${jiraKey}> is *In Review*.\n` +
            `Is the review complete? Please move it to *QA Ready* when done so QA can pick it up.`;
        }

        await client.chat.postMessage({
          channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false,
          text: pingText,
        });
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

// ── AI intent router: understand natural language commands ──
// Lets people talk to the bot naturally in English or Vietnamese instead
// of memorizing exact command prefixes.
async function interpretCommand(rawText) {
  const cleaned = rawText.replace(/<@[A-Z0-9]+>/g, '@member').trim().substring(0, 400);
  try {
    const raw = (await aiCall(
      `You route messages for QA Bot, a Slack bot in Everfit bug-report channels. Users write in English or Vietnamese.
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
- "unknown": greetings, thanks, or anything else

JSON only, no other text.`,
      cleaned, 50, true
    )).trim();
    const parsed = JSON.parse(raw.substring(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const valid = ['analyze', 'create_card', 'assign', 'reassign', 'followup', 'troubleshoot', 'cancel', 'weekly_report'];
    return valid.includes(parsed.action) ? parsed.action : 'unknown';
  } catch { return 'unknown'; }
}

slackApp.event('app_mention', async ({ event, client, logger }) => {
  if (!MONITORED_CHANNELS[event.channel]) return;

  const { user_id: botUserId, bot_id: botBotId } = await client.auth.test();
  const triggerText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();

  // Fast path: exact command prefixes (no AI cost, instant)
  const isAnalyze        = /^(analyze|analysis|phân tích|phan tich)/.test(triggerText);
  const isWeeklyReport   = /^(weekly report|weekly|báo cáo tuần)/.test(triggerText);
  const isCreateCard     = /^(create\s?(card|ticket)|log\s?(bug|this)|assign\s?to)/.test(triggerText);
  const isFollowup       = /^(followup|follow[- ]up|check\s?status|update)/.test(triggerText);
  const isTroubleshoot   = /^(troubleshoot|trouble\s?shoot|debug|how\s?to\s?fix)/.test(triggerText);
  const isCancel         = /^(cancel|stop|close)/.test(triggerText);
  const isChangeAssignee = /^(reassign|change\s?assignee|assign\s?this\s?to|move\s?to)/.test(triggerText);
  const matchedFastPath  = isAnalyze || isWeeklyReport || isCreateCard || isFollowup || isTroubleshoot || isCancel || isChangeAssignee;

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

    const doAnalyze  = isAnalyze        || aiAction === 'analyze';
    const doWeekly   = isWeeklyReport   || aiAction === 'weekly_report';
    const doCreate   = isCreateCard     || aiAction === 'create_card' || aiAction === 'assign';
    const doFollowup = isFollowup       || aiAction === 'followup';
    const doTrouble  = isTroubleshoot   || aiAction === 'troubleshoot';
    const doCancel   = isCancel         || aiAction === 'cancel';
    const doReassign = isChangeAssignee || aiAction === 'reassign';
    const aiWantsAssign = aiAction === 'assign' || triggerText.startsWith('assign to');

    if (!doAnalyze && !doWeekly && !doCreate && !doFollowup && !doTrouble && !doCancel && !doReassign) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts || event.ts,
        text:
          `I couldn't figure out what you need — just tell me in plain English or Vietnamese, e.g. _"log this and assign to @Huy"_, _"status?"_, _"tạo card giúp em"_.\n\n` +
          `Or use a command:\n` +
          `• \`analyze\` — issue analysis · \`create card\` — Jira ticket · \`assign to @person\`\n` +
          `• \`followup\` — check status · \`reassign to @person\` · \`troubleshoot\` — CS steps\n` +
          `• \`weekly report\` · \`cancel\` — stop follow-up tracking`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'question', timestamp: event.ts }).catch(() => {});
      return;
    }

    const threadTs       = event.thread_ts || event.ts;
    const slackThreadUrl = buildSlackThreadUrl(event.channel, threadTs);
    const context = event.thread_ts
      ? await getThread(client, event.channel, event.thread_ts)
      : event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!context || context.trim().length < 10) {
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
      logger.info('[Bot] Analyze triggered manually');
      const analysis = await analyzeThread(context, slackThreadUrl);
      const squad    = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);
      const contacts = resolveContactMentions(squad ? getSquadContacts(squad) : null);
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs, unfurl_links: false,
        text: buildAnalysisReply(analysis, squad, contacts),
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'mag_right', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // WEEKLY REPORT — manual trigger
    // ═══════════════════════════════════════════
    if (doWeekly) {
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
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: '⚠️ No active follow-up found for this thread.' });
      } else {
        tracked.done = true;
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
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `⚠️ Please mention the new assignee: \`@QA Bot reassign to @person\`` });
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
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: '⚠️ No tickets found in this thread.' });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (threadKeys.length > 1 && !specificKey) {
        const list = threadKeys.map(k => `• \`@QA Bot reassign to @person ${k}\` → <${JIRA_HOST}/browse/${k}|${k}>`).join('\n');
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `📋 Multiple tickets in this thread — which one?\n\n${list}` });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      const targetKey = (specificKey && threadKeys.includes(specificKey)) ? specificKey : threadKeys[0];
      const newJiraId = await resolveJiraAccountId(client, mentionedUsers[0]);
      if (!newJiraId) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `⚠️ Could not find Jira account for <@${mentionedUsers[0]}>. Please assign manually.` });
      } else {
        await axios.put(`${JIRA_HOST}/rest/api/3/issue/${targetKey}/assignee`, { accountId: newJiraId }, {
          headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
        });
        const tracked = followUpStore.get(targetKey);
        if (tracked) tracked.assigneeSlackIds = [mentionedUsers[0]];
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
      const tracked = await findOrRegisterTracked(client, event.channel, threadTs, botBotId, botUserId);

      // ── No ticket yet → tag SM/PC to review and assign ──
      if (!tracked) {
        const squad    = detectSquadFromKeywords(context);
        const contacts = resolveContactMentions(squad ? getSquadContacts(squad) : null);

        const smPcMention = contacts
          ? `${contacts.smMention} ${contacts.pcMention}`
          : `<!subteam^${GROUP_SM}>`;

        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text:
            `📋 No Jira ticket has been created for this thread yet.\n` +
            `${smPcMention} — please review this issue and either:\n` +
            `• Create a ticket: \`@QA Bot create card\`\n` +
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
      const reply = await aiCall(
        `You are QA Bot for Everfit. Provide practical troubleshooting steps for the CS team to try BEFORE escalating to dev. CS are non-technical — steps must be clear and specific.

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
    const analysis = await analyzeThread(context, slackThreadUrl);
    logger.info(`[Bot] Severity=${analysis.severity} · tickets=${analysis.tickets.length}`);

    const squad = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);

    // Parse trigger: direct assignees vs cc/fyi (cc'd members are NEVER assigned)
    const { assignees: triggerAssignees, ccIds } = parseAssigneesFromTrigger(event.text, botUserId);
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

    // Shortcut: "assign to @X" when a LIVE ticket already exists
    if (aiWantsAssign && liveKeys.length && triggerAssignees.length) {
      const targetKey = liveKeys[0];
      const newJiraId = await resolveJiraAccountId(client, triggerAssignees[0]);
      if (newJiraId) {
        try {
          await axios.put(`${JIRA_HOST}/rest/api/3/issue/${targetKey}/assignee`, { accountId: newJiraId }, {
            headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
          });
          await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, unfurl_links: false, text: `✅ <${JIRA_HOST}/browse/${targetKey}|${targetKey}> reassigned to <@${triggerAssignees[0]}>.` });
        } catch (err) {
          await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, unfurl_links: false, text: `⚠️ Could not update <${JIRA_HOST}/browse/${targetKey}|${targetKey}> (${err.response?.status || err.message}). Please assign manually in Jira.` });
        }
      } else {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `⚠️ Could not find Jira account for <@${triggerAssignees[0]}>. Please assign manually.` });
      }
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      return;
    }

    // Dedup
    const newTickets = analysis.tickets.filter(ticket => {
      const isDupe = existingSummaries.some(existing => {
        const existingWords = new Set(existing.split(/\s+/).filter(w => w.length > 4));
        return ticket.summary.toLowerCase().split(/\s+/).filter(w => w.length > 4).filter(w => existingWords.has(w)).length >= 3;
      });
      if (isDupe) logger.info(`[Bot] Skipping duplicate: ${ticket.summary}`);
      return !isDupe;
    });

    if (!newTickets.length) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `⚠️ Similar tickets already exist: ${liveKeys.map(k => `<${JIRA_HOST}/browse/${k}|${k}>`).join(', ')}`,
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
    const threadAttachments = await getAllThreadAttachments(client, event.channel, threadTs);
    const createdJiras      = [];

    for (const { ticket, assigneeSlackId } of ticketJobs) {
      const jiraId = assigneeSlackId ? await resolveJiraAccountId(client, assigneeSlackId) : null;
      const jira   = await createJiraIssue({ ...ticket, severity: analysis.severity }, jiraId ? [jiraId] : []);
      if (sprintId) await addIssueToSprint(jira.key, sprintId);

      let uploadedCount = 0;
      for (const att of threadAttachments) {
        try {
          const buf = await downloadSlackFile(att.url);
          if (await uploadAttachmentToJira(jira.key, att.name, buf, att.mimetype)) uploadedCount++;
        } catch (_) {}
      }

      registerFollowUp({
        channelId: event.channel,
        threadTs,
        jiraKey: jira.key,
        jiraUrl: jira.url,
        squad:   ticket.squad || squad,
      });

      createdJiras.push({ jira, ticket, assigneeSlackIds: assigneeSlackId ? [assigneeSlackId] : [], uploadedCount });
    }

    // Short ticket confirmation only — no re-analysis
    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text: buildTicketReply(createdJiras),
    });

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});

  } catch (err) {
    logger.error('[Bot] Unhandled error:', err.response?.data ?? err.message);
    await client.chat.postMessage({
      channel: event.channel, thread_ts: event.thread_ts || event.ts,
      text: `❌ Client Report Bot error: \`${err.message}\``,
    });
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
  }
});

// ─────────────────────────────────────────────
// AUTO-ANALYZE — fires on every new thread in monitored channels
// ─────────────────────────────────────────────

slackApp.event('message', async ({ event, client, logger }) => {
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

    const slackThreadUrl = buildSlackThreadUrl(event.channel, event.ts);
    const context = text;

    const analysis = await analyzeThread(context, slackThreadUrl);
    logger.info(`[Bot] Auto-analyze: Severity=${analysis.severity}`);

    const squad    = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);
    const contacts = resolveContactMentions(squad ? getSquadContacts(squad) : null);

    const replyText = buildAnalysisReply(analysis, squad, contacts);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      unfurl_links: false,
      text: replyText,
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
});

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
  const WEEKLY_MAIN = `<@U0142GU335F> <@U0445EQS1ED> <@UQZ2PNPN3>`;
  const WEEKLY_CC   = `cc <@U04PN2RHT4K> <@U08J7SGJGNM> <@U06401J6QR4> <@U08R7JP31CZ>`;

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
    'Core Product - Nutrition',
    'Core Product - Platform Capability',
    'Core Product - Engagement',
    'Core Product - Integration & Middleware',
    'Payment & Billing',
    'AI Features',
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
function register(realApp, realOpenai) {
  openai = realOpenai;
  loadKnowledgeBase();
  for (const [name, handler] of _registrations) realApp.event(name, handler);
  startFollowUpScheduler(realApp.client);
  startWeeklyReportScheduler(realApp.client);
  console.log('✅ [ClientReport] module active (gpt-4o-mini) — monitoring:', Object.values(MONITORED_CHANNELS).join(', '));
}

module.exports = { register, MONITORED_CHANNELS };
