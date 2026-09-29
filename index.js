require('dotenv').config();
// ── Recent log lines, readable from Slack ('@QA Agent logs') ──────────
// Railway logs aren't reachable from Slack; keep the last lines in memory
// so admins can debug without opening Railway. Resets on restart.
const LOG_RING = [];
const LOG_RING_MAX = parseInt(process.env.LOG_RING_MAX || '800', 10);
for (const lvl of ['log', 'info', 'warn', 'error']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...args) => {
    try {
      const t = new Date(Date.now() + 7 * 3600 * 1000).toISOString().substring(5, 19).replace('T', ' ');
      const line = args.map(a => typeof a === 'string' ? a : (a && a.stack) ? a.stack.split('\n').slice(0, 3).join(' | ') : JSON.stringify(a)).join(' ');
      LOG_RING.push(`${t}${lvl === 'warn' ? ' WARN' : lvl === 'error' ? ' ERROR' : ''} ${line}`.substring(0, 600));
      if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
    } catch (_) {}
    orig(...args);
  };
}

const { App } = require('@slack/bolt');
const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');

const lib = require('./lib');
const {
  JIRA_HOST, JIRA_PROJECT, jiraAuth,
  SMART_MODEL, aiComplete,
  agentStatus, getActiveSprintId, getIssueSnapshot,
  resolveUserName, resolveInlineMentions, qaTaskWork,
} = lib;

const clientReport = require('./client-report');
const release = require('./release');
console.log(`[Boot] QA Agent build ${(process.env.RAILWAY_GIT_COMMIT_SHA || 'local').substring(0, 7)} · node ${process.version} · mem limit ${Math.round(require('os').totalmem() / 1048576)}MB`);

// Survive unexpected errors: Node exits on unhandled rejections by default,
// which would take the whole bot down for every user until a restart.
// Rolling record of recent failures — surfaced via '@QA Agent status'
// and /health so problems are diagnosable from Slack without Railway.
const RECENT_ERRORS = [];
function recordError(where, err) {
  RECENT_ERRORS.unshift({ at: new Date().toISOString(), where, msg: (err?.message || String(err)).substring(0, 300) });
  RECENT_ERRORS.length = Math.min(RECENT_ERRORS.length, 10);
}
const BOOT_AT = Date.now();
const BUILD   = (process.env.RAILWAY_GIT_COMMIT_SHA || 'local').substring(0, 7);

// Graceful shutdown: Railway sends SIGTERM on every deploy. Clean up any
// in-flight status messages and tell people to retry, then exit.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.warn(`[Shutdown] ${sig} received`);
    try { await lib.shutdownLiveStatuses(sig); } catch (_) {}
    process.exit(0);
  });
}

process.on('unhandledRejection', (reason) => {
  recordError('unhandledRejection', reason);
  console.error('[FATAL-GUARD] Unhandled rejection:', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  recordError('uncaughtException', err);
  console.error('[FATAL-GUARD] Uncaught exception:', err?.stack || err);
});
setInterval(() => {
  const m = process.memoryUsage();
  const rssMB = Math.round(m.rss / 1048576);
  if (rssMB > 300) console.warn(`[Mem] rss=${rssMB}MB heap=${Math.round(m.heapUsed / 1048576)}MB — watch for OOM`);
}, 60000).unref();
const { runAgent } = require('./agent');

const slackApp = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


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
  return `https://everfitt.slack.com/archives/${channelId}/p${ts}`;
}

// ── Get the Slack user ID of the first (non-bot) message in a thread ──
async function getThreadReporterSlackId(client, channelId, threadTs) {
  try {
    const result   = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 10 });
    const messages = result.messages || [];
    for (const msg of messages) {
      if (msg.bot_id || msg.subtype === 'bot_message') continue;
      if (msg.user) return msg.user;
    }
    return null;
  } catch (err) {
    console.warn('[QABot] Could not get thread reporter:', err.message);
    return null;
  }
}

async function getThread(client, channelId, threadTs) {
  const t0 = Date.now();
  const result   = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 200 });
  const messages = (result.messages || []).filter(m => !(m.bot_id || m.subtype === 'bot_message'));

  // Warm every author + inline-mention name in PARALLEL first. Previously
  // this loop made 2+ sequential users.info calls per message (200 deep),
  // which hung entire requests in long threads.
  const uids = new Set();
  for (const msg of messages) {
    if (msg.user) uids.add(msg.user);
    for (const m of (msg.text || '').matchAll(/<@([A-Z0-9]+)>/g)) uids.add(m[1]);
  }
  await lib.warmUserNames(client, [...uids]);
  console.log(`[QABot] Thread context: ${messages.length} msgs, ${uids.size} users resolved in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const lines = [];
  for (const msg of messages) {
    const name = lib.replaceMentionsCached(`<@${msg.user}>`).replace(/^@/, '') || msg.username || 'user';
    const text = lib.replaceMentionsCached(msg.text || '')
      // User-group / subteam mentions <!subteam^ID|display> or <!subteam^ID>
      .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '@$1')
      .replace(/<!subteam\^[A-Z0-9]+>/g, '')
      // Channel-wide mentions
      .replace(/<!channel>/g, '@channel')
      .replace(/<!here>/g, '@here')
      // Channel links <#CID|name>
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
      // Any remaining < > encoded tokens
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!text) continue;  // skip empty messages after cleaning
    lines.push(`[${name}]: ${text}`);
  }
  return lines.join('\n');
}

// ── Collect attachments from ALL messages in a thread ──
// Attachment bounds: a single screen recording must never eat the whole
// request window (this caused 'stuck' creates in threads with videos).
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;   // Jira rejects big files anyway
const MAX_ATTACHMENTS      = 8;

async function getAllThreadAttachments(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    const messages = result.messages || [];
    const attachments = [];
    const skipped = [];
    for (const msg of messages) {
      // Skip bot messages — don't re-upload bot's own posts
      if (msg.bot_id) continue;
      const files = msg.files || [];
      for (const f of files) {
        if (!f.url_private_download) continue;
        if ((f.size || 0) > MAX_ATTACHMENT_BYTES) {
          console.log(`[QABot] Skipping large attachment ${f.name} (${Math.round((f.size || 0) / 1048576)}MB > ${MAX_ATTACHMENT_BYTES / 1048576}MB cap)`);
          skipped.push({ name: f.name || 'file', size: f.size || 0 });
          continue;
        }
        attachments.push({
          name:     f.name || f.title || 'attachment',
          url:      f.url_private_download,
          mimetype: f.mimetype || 'application/octet-stream',
          size:     f.size || 0,
        });
        if (attachments.length >= MAX_ATTACHMENTS) {
          console.log(`[QABot] Attachment cap reached (${MAX_ATTACHMENTS})`);
          return { attachments, skipped };
        }
      }
    }
    console.log(`[QABot] Thread has ${attachments.length} attachment(s), ${skipped.length} skipped as too large`);
    return { attachments, skipped };
  } catch (err) {
    console.warn('[QABot] Could not get attachments:', err.message);
    return { attachments: [], skipped: [] };
  }
}

async function downloadSlackFile(url) {
  const res = await axios.get(url, {
    headers:      { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: 'arraybuffer',
    timeout:      30000,    // 30s — beyond this the request is effectively hung
    maxContentLength: MAX_ATTACHMENT_BYTES,
    maxBodyLength:    MAX_ATTACHMENT_BYTES,
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
        timeout:          30000,
        maxContentLength: MAX_ATTACHMENT_BYTES,
        maxBodyLength:    MAX_ATTACHMENT_BYTES,
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

// ── Detect requested issue type from the trigger text ──
// ── Classify Bug vs Task from thread content ─────────────────────────────
// 1. Explicit keyword in trigger → trust it immediately (no AI call).
// 2. No keyword → ask GPT to decide from the thread so we don't default
//    every bare trigger (e.g. "assign to @X") to Bug.
async function classifyIssueType(triggerText, threadContext) {
  const lower          = (triggerText || '').toLowerCase();
  const threadLower    = (threadContext || '').toLowerCase();
  const combined       = `${lower} ${threadLower}`;

  // ── Fast-path: explicit Bug keywords ──
  if (/\bbug\b|log bug|create bug|report bug|báo lỗi|tạo bug/.test(lower)) return 'Bug';

  // ── Fast-path: explicit Task keywords (trigger text) ──
  if (/\btask\b|tạo task|create task|log task/.test(lower)) return 'Task';

  // ── Fast-path: clear Task signals in thread content ──
  // Covers Vietnamese action phrases, design/implement requests, BA/PC-style asks
  const taskSignals = [
    /handle\s+luôn/,          // "handle luôn phần này"
    /anh\s+handle/,           // "anh handle phần này"
    /em\s+handle/,
    /nhờ\s+\S+\s+handle/,   // "nhờ @X handle"
    /làm\s+phần\s+này/,      // "làm phần này"
    /xử\s+lý\s+phần/,        // "xử lý phần này"
    /implement\s+/,
    /thiết\s+kế/,             // design reference
    /theo\s+design/,          // "theo design"
    /update\s+design/,
    /theo\s+figma/,
    /figma/,
    /nhờ\s+team\s+process/,  // "nhờ team process"
    /process\s+như\s+sau/,   // "process như sau"
    /thêm\s+tính\s+năng/,    // "thêm tính năng"
    /add\s+(the\s+)?feature/,
  ];
  if (taskSignals.some(r => r.test(combined))) {
    console.log('[QABot] classifyIssueType: fast-path Task (thread signal matched)');
    return 'Task';
  }

  // ── Fast-path: clear Bug signals in thread content ──
  const bugSignals = [
    /\blỗi\b/,               // Vietnamese "lỗi" = bug/error
    /bị\s+lỗi/,
    /bị\s+crash/,
    /app\s+crash/,
    /không\s+hoạt\s+động/,   // "không hoạt động" = not working
    /sai\s+prefix/,
    /\bnot\s+working\b/,
    /\bbroken\b/,
    /\bcrash\b/,
    /\berror\b/,
    /\bregression\b/,
    /nhờ\s+\S+\s+fix/,      // "nhờ mn fix", "nhờ anh fix issue"
    /nhờ\s+\S+\s+assign.*fix/, // "nhờ mn assign dev fix issue"
    /\bfix\s+issue\b/,
    /\bfix\s+bug\b/,
    /\bwhite\s+space\b/,    // common UI bug term
    /\bblack\s+screen\b/,
    /should\s+(?:not|remove|fix)/i,  // "[iOS][X] SHOULD remove the white space"
  ];
  if (bugSignals.some(r => r.test(combined))) {
    console.log('[QABot] classifyIssueType: fast-path Bug (thread signal matched)');
    return 'Bug';
  }

  // ── AI fallback: no clear keyword found ──
  try {
    const res = await aiComplete({
      model:      'gpt-4o-mini',
      max_tokens: 10,
      messages: [
        {
          role: 'system',
          content:
            'You classify Slack threads as Bug or Task. Reply with exactly one word: Bug or Task.\n\n' +
            'TASK signals (choose Task when you see these):\n' +
            '- Request to implement, build, add, or handle something\n' +
            '- References to a design, Figma, or mockup\n' +
            '- Vietnamese: "handle luôn", "làm phần này", "xử lý", "nhờ xử lý", "anh/em handle"\n' +
            '- Request comes from a BA, PC, or Product role\n' +
            '- No mention of anything being broken\n\n' +
            'BUG signals (choose Bug when you see these):\n' +
            '- Something that was working but is now broken\n' +
            '- Error, crash, wrong data, unexpected behavior\n' +
            '- Vietnamese: "lỗi", "bị lỗi", "không hoạt động", "sai"\n' +
            '- QA reporting an issue found during testing\n\n' +
            'When in doubt and nothing is described as broken → choose Task.',
        },
        { role: 'user', content: threadContext || triggerText },
      ],
    });
    const answer = (res.choices[0].message.content || '').trim();
    console.log(`[QABot] classifyIssueType: AI answered "${answer}"`);
    if (answer === 'Task') return 'Task';
  } catch (err) {
    console.warn('[QABot] classifyIssueType AI call failed, defaulting to Bug:', err.message);
  }

  return 'Bug';
}

// ── Parse QA bug with Claude (robust) ────────
// ── Extract a meaningful summary from thread when GPT fails ─────────────
// Looks for [Platform][Feature] prefix pattern already present in the thread
// (e.g. "[API][Check-In Form][Notification]") and uses it directly.
function buildFallbackSummary(context, platform) {
  const text = (context || '');

  // Find [Bracket][Bracket]... pattern — Everfit teams often prefix threads this way
  const prefixMatch = text.match(/\[([A-Za-z][A-Za-z\s/0-9-]*)\]((?:\[[^\]]+\])+)/);
  if (prefixMatch) {
    const featurePart = prefixMatch[2]; // e.g. "[Check-In Form][Notification][Reminder]"
    // Try to find an "Actual" line for the bug detail
    const actualMatch = text.match(/(?:\*?Actual\*?|Step\s*\(\d+\))[:\s]+([^\n•*`]{5,60})/i);
    const detail = actualMatch ? ' — ' + actualMatch[1].trim() : '';
    const summary = `[${platform}]${featurePart}${detail}`.slice(0, 120);
    return summary;
  }

  // Fall back to first non-command line with at least 8 chars
  for (const line of text.split('\n')) {
    const stripped = line.replace(/^\[[^\]]+\]:\s*/, '').trim();
    if (stripped.length >= 8 && !/^assign to|^@|^cc |^fyi /i.test(stripped)) {
      return `[${platform}][Bug] ${stripped.slice(0, 80)}`;
    }
  }

  return `[${platform}][Bug] Bug report from QA — please update summary`;
}

async function parseBugReport(context, userDirective = '') {
  const res = await aiComplete({
    model:      userDirective ? SMART_MODEL : 'gpt-4o-mini',
    max_tokens: userDirective ? 6000 : 3000,
    messages: [
      { role: 'system', content: `You are QABot for Everfit. Parse a QA bug report from a Slack thread.

CRITICAL RULES:
1. Read ALL messages in the thread (except bot messages) to collect every bug/issue reported.
2. Ignore bot messages (lines starting with "[qa-bot]" or "[bug-reporting-tracker]").
3. Ignore ONLY pure bot-command lines — messages that contain NOTHING BUT @mentions + assignment keywords, e.g.:
   - "@QA Bot (AI) assign to @X" — ignore
   - "@qa-bot create task" — ignore
   Messages that DESCRIBE A BUG while also mentioning "assign" or "nhờ" (e.g. "nhờ mn assign dev fix issue white space at bottom [iOS Client][Screen]") are BUG REPORTS — NEVER ignore these.
4. Extract every actual bug: what is broken, on what platform, steps to reproduce.
5. Translate any Vietnamese content to English.
6. The summary should describe the bug clearly — NOT include "[Thanh Ngo]:" or usernames or "Nhờ team check" boilerplate.
7. NEVER return an empty array. If the thread contains ANY bug description (even just a screen name + symptom), return at least one ticket. A short, vague description is still a valid bug — do your best.
8. IMPORTANT — Structured Vietnamese bug reports: threads formatted as "[Platform][Feature][SubFeature]\nNhờ... check\n*Step:*\n1...\n*Actual*:\n...\n*Expected*:\n..." ARE bug reports. Parse the [Platform][Feature] as the prefix, the Actual section as the bug description, and the Expected section as expected behavior. Never return [] for these even if the message asks someone to "check" (nhờ check = "please check/verify this bug").


COMMAND-EMBEDDED REQUESTS: the mention message itself may contain the full request (e.g. "Create a ticket under epic UP-51189 for upgrading account X to Studio 1000 clients and assign to me") — parse the work request from that message. A ticket key after "epic"/"under"/"parent" is the PARENT EPIC: never include it in the summary and never treat it as the subject of the ticket.

MULTI-BUG RULES (VERY IMPORTANT — err on the side of ONE ticket):
- REQUESTER DIRECTIVE OVERRIDES EVERYTHING BELOW: if the requester's directive asks for a specific number of tickets or one per issue ("create 3 tickets for 3 issues", "tách card từng lỗi", "one card per bug"), you MUST enumerate the distinct issues in the thread and return exactly one ticket per issue (up to 6) — the merge-into-one default does NOT apply.
- DEFAULT (no directive): Create exactly ONE ticket per thread. Most bug reports are a single bug.
- If the thread reports MULTIPLE RELATED issues on the SAME feature/screen → merge them into ONE ticket. List all issues in the description.
- ONLY create SEPARATE tickets if bugs are COMPLETELY UNRELATED: different features AND different root causes AND clearly independent (e.g., "login is broken" + "profile page has typo" = 2 tickets).
- "Different platforms" alone is NOT a reason to split. If the same bug affects Web + API, pick the PRIMARY platform and create ONE ticket.
- When in doubt, create ONE ticket with all information. QA can manually split later if needed.
- NEVER create more than 2 tickets from a single thread.

Return ONLY a valid JSON ARRAY (NO markdown fences, NO explanation):

[
  {
    "summary": "[Platform][Feature] Clear bug description. Platform MUST be one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach. Under 80 chars total. NEVER include @mentions, subteam IDs, or [Thanh Ngo]: prefixes.",
    "priority": "Highest" or "High" or "Medium" or "Low" or "Lowest",
    "platform": "one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach",
    "description": "Use this EXACT structure with ## section headings (real newlines, **bold** for key terms):\n\n## Bug Description\n[1-3 sentences: what exactly is broken, under what conditions, and who is affected. Be specific — use details from the thread.]\n\n## Root Cause\n[Why this happens technically. Extract from thread if mentioned. If not stated, write a concise inference based on symptoms. Never write N/A here.]\n\nImpact:\n- [specific user-facing or system impact — e.g. 'Coaches cannot complete checkout', not just 'affects users']\n- [add more bullets if multiple distinct impacts]\n\n## Expected Behavior\n- [specific expected outcome — what SHOULD happen]\n- [add more if needed]\n\n## Steps to Reproduce\n1. [specific step from thread — not generic like 'navigate to page']\n2. [specific step]\n3. [specific step — add more if needed]\n\n## Reference\n- [ONLY list ticket numbers explicitly mentioned in thread, e.g. PAY-1567, UP-XXXX. DO NOT write N/A. If none mentioned, omit this section entirely — the Slack thread will be added automatically.]",
    "assignee_names": ["Full Name of person asked to fix — look for '@X check', 'nhờ @X', '@X fix', '@X coi với'. Empty array [] if no one was tagged for the fix."],
    "acceptance_criteria": ["SHOULD <expected behavior statement>", "SHOULD NOT <negative behavior statement>"]
  }
]

ACCEPTANCE CRITERIA RULES:
- Generate 2-5 clear, testable acceptance criteria for each bug.
- Each item MUST start with "SHOULD" or "SHOULD NOT".
- Focus on what the fix must achieve, not how to reproduce.
- Examples:
  - Bug: "OTP boxes not cleared after clicking Resend"
    → ["SHOULD clear all OTP input boxes when user clicks Resend", "SHOULD reset cursor focus to the first OTP box after Resend", "SHOULD NOT retain old OTP digits after Resend is clicked"]
  - Bug: "App crashes when opening video"
    → ["SHOULD play video without crashing", "SHOULD show loading indicator while video buffers", "SHOULD NOT crash when video format is unsupported"]
- If the bug is trivial (typo, spacing) or acceptance criteria is not useful, return empty array [].

PLATFORM DETECTION:
- Web → dashboard UI issues, desktop browser
- API → backend, data, sync, auth
- iOS Client → iOS app (client-facing)
- iOS Coach → iOS app (coach-facing)
- Android Client → Android app (client-facing)
- Android Coach → Android app (coach-facing)
- When BOTH iOS AND Android are mentioned as having issues, pick the one most central to the report

PRIORITY RUBRIC (follow strictly):

"Highest" — Blocker:
- App/web completely down or crashes on launch
- Data loss or corruption (lost workouts, payments, saved work)
- Security issue (auth bypass, data leak)
- Payment failure
- Cannot log in at all

"High" — Major:
- Core feature fully broken for many users (e.g., cannot assign workouts at all)
- Crash on a specific common action
- Production-only issue affecting active coaches/clients
- Sync failure blocking client usage

"Medium" — Normal:
- Feature partially broken but has a workaround
- Non-crash but confusing UX
- Affects a limited set of users/scenarios
- Typos (misspellings, wrong words in copy)
- UI issues that block understanding of data/action (e.g., button completely missing its label)

"Low" — Minor:
- Spacing, padding, alignment, or color issues on client's interface that are NOT critical (data/action still understandable)
- UI flicker, minor animation glitches
- Edge case affecting rare scenarios
- Nice-to-have improvements

"Lowest" — Trivial:
- Internal-only cosmetic issues (coach admin backend visuals)
- Non-blocking suggestions

Examples:
- "Bottom sheet value and unit misaligned, user can still read them" → Low
- "Button flickers when switching tabs" → Low
- "Typo in error message 'occured' should be 'occurred'" → Medium
- "Client cannot mark workout as complete" → High
- "App crashes on launch for iOS 17 users" → Highest

NEVER return null/undefined/empty. Always make a reasonable guess based on the first message.` },
      { role: 'system', content: lib.PRIORITY_RUBRIC + '\n\nSet each ticket\'s "priority" (Highest/High/Medium/Low/Lowest) by this rubric.' },
      { role: 'user', content: `${userDirective ? `REQUESTER DIRECTIVE (obey this): ${userDirective}\n\n` : ''}QA bug report thread:\n\n${context}` },
    ],
  });

  const raw = res.choices[0].message.content.replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }

  // Normalize to array
  // Treat both null AND empty array as a failed parse — return a fallback ticket
  const ticketsRaw = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  if (ticketsRaw.length === 0) {
    const fallbackPlatform = 'iOS Client';
    return [{
      summary:             buildFallbackSummary(context, fallbackPlatform),
      priority:            'Medium',
      platform:            fallbackPlatform,
      description:         'Description not parsed automatically. Please update manually.',
      assignee_names:      [],
      acceptance_criteria: [],
    }];
  }

  // Defensive defaults for each ticket
  return ticketsRaw.map(t => {
    const platform = t.platform || 'Web';
    return {
      summary:             normalizeSummaryPrefix(t.summary || '', platform),
      priority:            t.priority       || 'Medium',
      platform,
      description:         t.description    || 'Description not parsed. Please update manually.',
      assignee_names:      Array.isArray(t.assignee_names) ? t.assignee_names : [],
      acceptance_criteria: Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria : [],
    };
  });
}

// ── Parse a TASK request from a Slack thread ─────
async function parseTaskReport(context, userDirective = '') {
  const res = await aiComplete({
    model:      userDirective ? SMART_MODEL : 'gpt-4o-mini',
    max_tokens: userDirective ? 6000 : 3000,
    messages: [
      { role: 'system', content: `You are QABot for Everfit. Parse a TASK request from a Slack thread.

CRITICAL RULES:
1. Read ALL messages in the thread (except bot messages) to understand what work is being requested.
2. Ignore bot messages (lines starting with "[qa-bot]" or "[bug-reporting-tracker]").
3. Ignore ONLY pure bot-command lines — messages that contain NOTHING BUT @mentions + assignment keywords, e.g.:
   - "@QA Bot (AI) assign to @X" — ignore
   - "@qa-bot create task" — ignore
   Messages that DESCRIBE A TASK while mentioning "assign" or "nhờ" are TASK DESCRIPTIONS — NEVER ignore these.
4. Translate any Vietnamese content to English.
5. The summary should describe the TASK clearly (what to do) — NOT include "[Thanh Ngo]:" or usernames or "Nhờ team check" boilerplate.
6. A task is work to be done (improvement, new feature, configuration, follow-up). It is NOT a bug report.
7. NEVER return an empty array. If the thread describes ANY task or request, return at least one ticket.

COMMAND-EMBEDDED REQUESTS: the mention message itself may contain the full request (e.g. "Create a ticket under epic UP-51189 for upgrading account X to Studio 1000 clients and assign to me") — parse the work request from that message. A ticket key after "epic"/"under"/"parent" is the PARENT EPIC: never include it in the summary and never treat it as the subject.

MULTI-TASK RULES (VERY IMPORTANT — err on the side of ONE ticket):
- DEFAULT: Return exactly ONE ticket. Almost every task thread is a single task.
- REQUESTER DIRECTIVE OVERRIDE: if the requester's directive asks for a specific number of tickets or one per item, enumerate the distinct requests and return one ticket per request (up to 6).
- A task described MULTIPLE TIMES in different words is still ONE task — NEVER create duplicate tickets for rephrased versions of the same request.
- If the thread requests MULTIPLE RELATED items on the SAME feature/screen → merge into ONE ticket with all requirements listed.
- ONLY create SEPARATE tickets when requests are COMPLETELY UNRELATED: different features AND independently deliverable (e.g., "update login page copy" + "add export button to reports" = 2 tickets).
- Discussion, clarification, agreement, or restating the request are NOT new tasks.
- When in doubt, return ONE ticket.

Return ONLY a valid JSON ARRAY (NO markdown fences, NO explanation):

[
  {
    "summary": "[Platform][Feature] Clear task description. Platform MUST be one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach. Feature is the affected screen/module/area (e.g. 2FA, Workout Builder, Onboarding, Billing, Calendar). NEVER use the literal word 'Task' as the second prefix. Under 80 chars total. NEVER include @mentions, subteam IDs, or [Name]: prefixes.",
    "priority": "Highest" or "High" or "Medium" or "Low" or "Lowest",
    "platform": "one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach",
    "description": "Use this EXACT structure with ## section headings (real newlines, **bold** for key terms):\n\n## Context\n[2-3 sentences: who requested this, what needs to be done, and why. Include business or product context from the thread. Be specific.]\n\n## Requirements\n1. **[Short label for requirement 1]** — [specific description of what needs to be done]\n2. **[Short label for requirement 2]** — [specific description]\n[Add more numbered items as needed. Each MUST have a **bold label** followed by — and the detail.]\n\n## Reference\n- [ONLY list Figma links, design specs, or ticket numbers explicitly mentioned in thread (e.g. 'Figma design: [url]', 'PAY-XXXX'). DO NOT write N/A. If nothing extra is mentioned, omit this section — the Slack thread link will be added automatically.]",
    "assignee_names": ["Full Name of person asked to do this — look for '@X handle', 'nhờ @X', '@X làm', 'assign to @X'. Empty array [] if no one was tagged."],
    "acceptance_criteria": ["SHOULD <expected outcome>", "SHOULD NOT <negative outcome>"]
  }
]

ACCEPTANCE CRITERIA RULES:
- Generate 2-5 clear, testable acceptance criteria for each task.
- Each item MUST start with "SHOULD" or "SHOULD NOT".
- Focus on what the completed task must achieve.
- If the task is trivial or AC isn't useful, return empty array [].

PLATFORM DETECTION:
- Web → dashboard UI work, desktop browser
- API → backend, data, sync, auth
- iOS Client → iOS app (client-facing)
- iOS Coach → iOS app (coach-facing)
- Android Client → Android app (client-facing)
- Android Coach → Android app (coach-facing)

PRIORITY RUBRIC (for tasks, default to Medium unless thread suggests otherwise):
- "Highest" — Urgent business blocker, must be done immediately
- "High" — Important task with a near-term deadline
- "Medium" — Normal task, default
- "Low" — Nice-to-have, low urgency
- "Lowest" — Trivial / cleanup

NEVER return null/undefined/empty. Always make a reasonable guess based on the thread.` },
      { role: 'system', content: lib.PRIORITY_RUBRIC + '\n\nSet each ticket\'s "priority" (Highest/High/Medium/Low/Lowest) by this rubric.' },
      { role: 'user', content: `${userDirective ? `REQUESTER DIRECTIVE (obey this): ${userDirective}\n\n` : ''}Task request thread:\n\n${context}` },
    ],
  });

  const raw = res.choices[0].message.content.replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }

  const ticketsRaw = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  if (ticketsRaw.length === 0) {
    return [{
      summary:             '[Web][General] Task request — please update summary',
      priority:            'Medium',
      platform:            'Web',
      description:         'Description not parsed automatically. Please update manually.',
      assignee_names:      [],
      acceptance_criteria: [],
    }];
  }

  return ticketsRaw.map(t => {
    const platform = t.platform || 'Web';
    return {
      summary:             normalizeSummaryPrefix(t.summary || '', platform),
      priority:            t.priority       || 'Medium',
      platform,
      description:         t.description    || 'Description not parsed. Please update manually.',
      assignee_names:      Array.isArray(t.assignee_names) ? t.assignee_names : [],
      acceptance_criteria: Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria : [],
    };
  });
}

// ── Detect App Icon Update requests from thread content ──────────────────
function isAppIconRequest(threadContext) {
  const lower = (threadContext || '').toLowerCase();
  return /app icon|icon update|update.*icon|change.*icon|new.*icon/.test(lower);
}

// ── Parse App Icon Update request ────────────────────────────────────────
async function parseAppIconRequest(context) {
  const res = await aiComplete({
    model:      'gpt-4o-mini',
    max_tokens: 500,
    messages: [
      {
        role: 'system',
        content: `Extract app icon update request details from this Slack thread.
Return ONLY valid JSON (no markdown fences, no explanation):
{
  "workspace_name": "Name of the workspace or client (e.g. 'Anchor Athletics'). Use 'Client' if not found.",
  "workspace_id": "The workspace/account ID — alphanumeric string like '64ed6ed86d85da001e9d5df8'. Empty string if not found.",
  "owner_email": "Email of the workspace owner. Empty string if not found.",
  "intercom_link": "Full Intercom conversation URL if mentioned. Empty string if not found."
}`,
      },
      { role: 'user', content: context },
    ],
  });

  let parsed = {};
  try {
    parsed = JSON.parse(res.choices[0].message.content.replace(/\`\`\`json|\`\`\`/g, '').trim());
  } catch (_) {}

  const name         = parsed.workspace_name || '';
  const wsId         = parsed.workspace_id   || '';
  const email        = parsed.owner_email    || '';
  const intercomLink = parsed.intercom_link  || '';

  // Build summary identifier: prefer workspace name+ID, fall back to email only
  let identifier;
  if (name && name !== 'Client') {
    identifier = wsId ? `${name} workspace (${wsId})` : name;
  } else if (email) {
    identifier = email;
  } else if (wsId) {
    identifier = wsId;
  } else {
    identifier = 'Client workspace';
  }
  const summary = `[Client Request][iOS Client][App icon] Process to change App icon for ${identifier}`;

  // Build description
  let workspaceInfo = '';
  if (wsId)   workspaceInfo += `\n- Workspace ID: ${wsId}`;
  if (email)  workspaceInfo += `\n- Workspace Owner: ${email}`;
  if (!wsId && !email) workspaceInfo += `\n- _(Please add workspace details manually)_`;

  let refs = '';
  if (intercomLink) refs += `\n- Intercom thread: ${intercomLink}`;
  // Slack thread injected automatically by handler

  const contextLine = name && name !== 'Client'
    ? `${name}'s workspace${wsId ? ` (${wsId})` : ''}`
    : email || wsId || 'the client workspace';

  const description =
    `## Context\nRequest from CS to update the app icon for ${contextLine}. ` +
    `A $50 charge applies — Payment Ops will handle billing in a separate ticket.` +
    `\n\n## Workspace Info${workspaceInfo}` +
    `\n\n## Assets\nOriginal Image (from customer)\nPreview Image (Android + iOS)` +
    `\n\n## Reference${refs || ''}`;  // 'Reference' (no s) matches injection regex

  const acceptance_criteria = [
    '[Dev] Update app icon for the workspace in the system',
    '[Dev] Confirm Payment Ops ticket created for $50 charge',
    '[QA] Attach original image (from customer) to this ticket',
    '[QA] Attach preview image (Android + iOS) to this ticket',
    '[QA] Verify app icon updated correctly on iOS Client',
    '[QA] Verify app icon updated correctly on Android Client',
    '[QA] Confirm no other workspaces are affected',
  ];

  return [{
    summary,
    priority:             'Medium',
    platform:             'iOS Client',
    description,
    assignee_names:       [],
    acceptance_criteria,
    skipPlatformOverride: true,   // fixed [Client Request] prefix — don't rewrite
  }];
}

// ── Merge near-duplicate parsed tickets ──────────────────────────────────
// The LLM sometimes returns 2-3 tickets for the same request when a thread
// rephrases one ask multiple times. Compare normalized summaries by token
// overlap (Jaccard) and drop duplicates, keeping the higher-priority one.
const PRIORITY_RANK = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };

function dedupeTickets(tickets) {
  if (tickets.length <= 1) return [...tickets]; // return a copy — caller mutates the original

  const tokenize = s => new Set(
    (s || '')
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, ' ')   // strip [Platform][Feature] prefixes
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );

  // Two similarity measures:
  // - Jaccard (intersection/union) catches near-identical summaries
  // - Overlap coefficient (intersection/smaller set) catches rephrased duplicates
  //   like "Enable continuous carousel looping" vs "Implement continuous looping for carousel"
  const isSimilar = (a, b) => {
    if (a.size === 0 || b.size === 0) return false;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const jaccard = inter / (a.size + b.size - inter);
    const overlap = inter / Math.min(a.size, b.size);
    return jaccard >= 0.5 || overlap >= 0.6;
  };

  const kept = [];
  for (const t of tickets) {
    const tTokens = tokenize(t.summary);
    const dupIdx = kept.findIndex(k => isSimilar(tokenize(k.summary), tTokens));
    if (dupIdx === -1) {
      kept.push(t);
    } else {
      // Duplicate — keep whichever has higher priority
      const existing = kept[dupIdx];
      if ((PRIORITY_RANK[t.priority] || 0) > (PRIORITY_RANK[existing.priority] || 0)) {
        kept[dupIdx] = t;
      }
      console.log(`[QABot] Deduped near-duplicate ticket: "${t.summary}"`);
    }
  }
  return kept;
}

// ── Section headers that should be bold in Jira description ──
const BOLD_HEADERS = [
  'Slack thread:', 'Steps to reproduce:', 'Expected behavior:',
  'Actual behavior:', 'Environment:', 'Note:', 'Web link:',
  'Goal:', 'Requirements:', 'Notes:', 'Impact:',
];

// ── Parse inline tokens: **bold** and URLs ───────────────────────────────
function parseInlineTokens(text) {
  const parts = [];
  const tokenRegex = /\*\*([^*]+)\*\*|(https?:\/\/[^\s]+)/g;
  let last = 0, match;
  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) });
    if (match[1] !== undefined) {
      parts.push({ type: 'text', text: match[1], marks: [{ type: 'strong' }] });
    } else {
      parts.push({ type: 'text', text: match[2], marks: [{ type: 'link', attrs: { href: match[2] } }] });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts.length > 0 ? parts : [{ type: 'text', text }];
}

function lineToAdfContent(line) {
  // Check if line starts with a known bold header
  for (const header of BOLD_HEADERS) {
    if (line.startsWith(header)) {
      const rest = line.slice(header.length);
      const parts = [{ type: 'text', text: header, marks: [{ type: 'strong' }] }];
      if (rest.length > 0) parts.push(...parseInlineTokens(rest));
      return parts;
    }
  }
  // Regular line — parse **bold** and URLs inline
  return parseInlineTokens(line);
}

function buildAdfDescription(text) {
  const lines = (text || '').split('\n').filter(l => l.trim() !== '');
  const content = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Ordered list: lines starting with "1." "2." etc.
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^\d+\.\s+/, '');
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: lineToAdfContent(itemText) }],
        });
        i++;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }

    // Bullet list: lines starting with "- "
    if (/^-\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^-\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^-\s+/, '');
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: lineToAdfContent(itemText) }],
        });
        i++;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }

    // ## Heading → ADF heading node (level 3)
    if (line.startsWith('## ')) {
      content.push({
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: line.slice(3).trim() }],
      });
      i++;
      continue;
    }

    // Regular paragraph
    content.push({ type: 'paragraph', content: lineToAdfContent(line) });
    i++;
  }

  return { type: 'doc', version: 1, content };
}

async function createJiraIssue(ticket, jiraAccountIds, epicKey, fixVersionId, parentKey, reporterJiraId, issueType = 'Bug', projectKey = JIRA_PROJECT, excludeKeys = []) {
  const fields = {
    project:     { key: projectKey },
    summary:     ticket.summary,
    issuetype:   { name: issueType },
    priority:    { name: ticket.priority },
    description: buildAdfDescription(ticket.description),
  };

  // Parent from channel canvas (if found)
  if (parentKey) fields.parent = { key: parentKey };
  if (epicKey) fields['customfield_10014'] = epicKey;
  if (fixVersionId) fields.fixVersions = [{ id: fixVersionId }];
  if (jiraAccountIds.length > 0) fields.assignee = { accountId: jiraAccountIds[0] };

  // Reporter — safe to set at creation (standard Jira field)
  if (reporterJiraId) fields.reporter = { accountId: reporterJiraId };

  const { key: issueKey, notes: createNotes } = await lib.createJiraIssueResilient(fields, { excludeKeys });
  if (createNotes.length) console.log(`[QABot] ${issueKey} created with adjustments: ${createNotes.join(' · ')}`);

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

  return {
    key: issueKey, url: `${JIRA_HOST}/browse/${issueKey}`, notes: createNotes,
    applied: {
      // what Jira actually accepted (resilient creator may have dropped fields)
      epic:       fields.customfield_10014 || fields.parent?.key || null,
      fixVersion: !!fields.fixVersions,
      fixVersionId: fields.fixVersions?.[0]?.id || null,
    },
  };
}

// ── Fetch Jira issue title ────────────────────
async function getJiraIssueTitle(issueKey) {
  return (await getJiraIssueInfo(issueKey)).title;
}

// Fetch both summary and status in one call — used by pickParentFromCanvas
async function getJiraIssueInfo(issueKey) {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/issue/${issueKey}?fields=summary,status`, {
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return {
      title:  res.data?.fields?.summary             || null,
      status: res.data?.fields?.status?.name        || null,
    };
  } catch { return { title: null, status: null }; }
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
  const upKeys   = [...new Set((canvasContent.match(/\b(?:UP|PAY|AIT|CHAL)-\d+\b/g)   || []))];
  const planKeys = [...new Set((canvasContent.match(/PLAN-\d+/g) || []))];
  console.log(`[QABot] Canvas keys: UP=${upKeys.join(',')} PLAN=${planKeys.join(',')}`);

  // Statuses that mean the epic is closed — don't parent new tickets here
  const CLOSED_STATUSES = new Set([
    'qa success', 'done', 'closed', 'released', 'complete',
    'completed', 'qa passed', "won't fix", 'resolved', 'cancelled',
  ]);

  // Build candidate list: direct UP tickets + Epics linked from PIs
  const candidates = [];

  // Direct UP keys from canvas
  for (const key of upKeys) {
    const { title, status } = await getJiraIssueInfo(key);
    if (!title) continue;
    if (CLOSED_STATUSES.has((status || '').toLowerCase())) {
      console.log(`[QABot] Skipping ${key} "${title}" — status: ${status}`);
      continue;
    }
    candidates.push({ key, title, status });
  }

  // Expand each PI to its linked Epics
  for (const plan of planKeys) {
    const linked = await getLinkedEpicsFromPI(plan);
    for (const e of linked) {
      if (candidates.find(c => c.key === e.key)) continue;
      const { title, status } = e.title
        ? { title: e.title, status: null }   // will re-fetch for status
        : await getJiraIssueInfo(e.key);
      // If we only got title from PI link (no status), fetch status separately
      const finalStatus = status ?? (await getJiraIssueInfo(e.key)).status;
      if (!title) continue;
      if (CLOSED_STATUSES.has((finalStatus || '').toLowerCase())) {
        console.log(`[QABot] Skipping ${e.key} "${title}" — status: ${finalStatus}`);
        continue;
      }
      candidates.push({ key: e.key, title, status: finalStatus });
    }
  }

  if (candidates.length === 0) {
    console.log('[QABot] No active (non-closed) candidate parents found');
    return null;
  }

  // Sort by UP number descending — higher = more recently created = current sprint ticket.
  // Ensures that when canvas has both old and new tickets for the same platform, the newer wins.
  candidates.sort((a, b) => {
    const numA = parseInt(a.key.replace('UP-', ''), 10) || 0;
    const numB = parseInt(b.key.replace('UP-', ''), 10) || 0;
    return numB - numA;
  });

  console.log(`[QABot] Active candidates (newest first): ${candidates.map(c => `${c.key}[${c.status}]="${c.title}"`).join(' | ')}`);

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

async function addIssueToSprint(issueKey, sprintId) {
  try {
    await axios.post(`${JIRA_HOST}/rest/agile/1.0/sprint/${sprintId}/issue`,
      { issues: [issueKey] },
      { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    return true;
  } catch (err) {
    console.warn(`[QABot] Sprint add failed for ${issueKey}:`, err.response?.status || err.message);
    return false;
  }
}

// ── Add acceptance criteria checklist items to a Jira issue ──
async function addAcceptanceCriteria(issueKey, items) {
  if (!items || items.length === 0) return 0;
  try {
    await axios.put(
      `${JIRA_HOST}/rest/checklist-for-jira/1.0/checklist/${issueKey}`,
      { items: items.map(name => ({ name, checked: false })) },
      { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    console.log(`[QABot] Added ${items.length} acceptance criteria to ${issueKey}`);
    return items.length;
  } catch (err) {
    console.warn(`[QABot] Checklist API (plugin) failed for ${issueKey}: ${err.message}`);
    // Fallback: try Jira standard Edit Issue API with checklist custom field
    // Common field IDs for Checklist for Jira Cloud: customfield_10101, Acceptance criteria
    const fallbackFieldIds = ['Acceptance criteria', 'customfield_10101', 'customfield_10102'];
    for (const fieldId of fallbackFieldIds) {
      try {
        await axios.put(
          `${JIRA_HOST}/rest/api/3/issue/${issueKey}`,
          { update: { [fieldId]: [{ add: items.map(name => ({ name, checked: false })) }] } },
          { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
        );
        console.log(`[QABot] Added ${items.length} acceptance criteria via field "${fieldId}" on ${issueKey}`);
        return items.length;
      } catch (_) { continue; }
    }
    console.warn(`[QABot] Could not add acceptance criteria to ${issueKey} — all methods failed`);
    return 0;
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

// ── Bucket a platform string into a broad category (api/web/ios/android) ──
// Used to decide whether the LLM-parsed platform matches the assignee's role.
function getPlatformBucket(platform) {
  if (platform === 'Product') return 'product';
  if (platform === 'Data') return 'data';
  if (platform === 'API') return 'api';
  if (platform === 'Web') return 'web';
  if (platform === 'iOS Coach'     || platform === 'iOS Client')     return 'ios';
  if (platform === 'Android Coach' || platform === 'Android Client') return 'android';
  return null;
}

const SQUAD_ROSTER = {
  'anh mai': 'qa',
  'anh phan': 'web',
  'bich thuy': 'qa',
  'canh tran': 'ios',
  'chien nguyen': 'api',
  'chieu hoang': 'qa',
  'chung ngo': 'qa',
  'danh truong': 'android',
  'dao nguyen': 'qa',
  'dat phan': 'api',
  'dong truong': 'fullstack',
  'dong vo': 'api',
  'duc trinh': 'api',
  'duy le': 'api',
  'duy nguyen': 'android',
  'ha duong': 'web',
  'ha nguyen': 'fullstack',
  'hang tran': 'qa',
  'hanh le': 'qa',
  'hanh tran': 'web',
  'hieu le': 'web',
  'hoai ho': 'android',
  'hoang nguyen': 'web',
  'hong tu': 'api',
  'hung nguyen': 'api',
  'huy be': 'api',
  'huy tran': 'web',
  'khai truong': 'qa',
  'khoa huynh': 'android',
  'lam bui': 'android',
  'lam nguyen': 'qa',
  'lanh ngo': 'qa',
  'le quoc hung': 'qa',
  'linh nguyen': 'api',
  'loc le': 'fullstack',
  'long nguyen hoang': 'api',
  'long phan': 'android',
  'long thai': 'api',
  'ly nguyen': 'qa',
  'nhan huynh': 'web',
  'nhat huy': 'api',
  'quy hoang': 'api',
  'tan huynh': 'ios',
  'thai bui': 'web',
  'thanh nguyen': 'web',
  'thanh tran': 'ios',
  'thao dinh': 'fullstack',
  'thao nguyen': 'qa',
  'thinh huynh': 'web',
  'thinh le': 'ios',
  'thu duong': 'qa',
  'thuong huynh': 'api',
  'toan tran': 'web',
  'tran nguyen': 'qa',
  'tran thanh nam': 'qa',
  'trang ngo': 'qa',
  'trung huynh': 'api',
  'trung nguyen': 'web',
  'tuan nguyen': 'api',
  'tuyen tran': 'ios',
  'uyen thao': 'qa',
  'van nguyen': 'qa',
  'viet mai': 'api',
  'viet phung': 'api',
  'vinh tran': 'web',
};

// ── Normalize a name for roster lookup: strip diacritics, lowercase ──
function normalizeName(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/\s*\([^)]*\)\s*/g, ' ')  // strip role tags like (BE)
    .replace(/\s+/g, ' ')
    .trim().toLowerCase();
}

// ── Look up a member's platform bucket in the squad roster ──
// Tries exact match first, then subset match (all roster-name words appear in the
// user name) to handle name-order differences and extra middle names.
function getRosterBucket(userName) {
  const n = normalizeName(userName);
  if (!n) return null;
  if (SQUAD_ROSTER[n]) return SQUAD_ROSTER[n];
  const userWords = new Set(n.split(' '));
  for (const [rosterName, bucket] of Object.entries(SQUAD_ROSTER)) {
    const rosterWords = rosterName.split(' ');
    if (rosterWords.every(w => userWords.has(w))) return bucket;
  }
  return null;
}

// ── Infer the bug's platform from the assignee's Slack role (display name + title) ──
// Rule (from QA team): the [Prefix] in the summary should follow the platform of
// the person being assigned, not whatever the thread discussion happened to be about.
// Examples:
//   - "Hong (BE)"          → API
//   - "Tien (iOS)"         → iOS Coach   (preserves Coach/Client if LLM already chose it)
//   - title "Backend Eng"  → API
// Returns null when the role can't be inferred — the LLM-parsed platform stays.
// Client vs Coach for a mobile platform: keep what the original platform
// said; otherwise weigh the report's wording ("client app", "client" vs
// "coach app", "coach"). Ties default to Client in report wording, Coach
// when nothing points either way (internal QA threads).
function mobileSide(originalPlatform, text) {
  if (/client/i.test(originalPlatform || '')) return 'Client';
  if (/coach/i.test(originalPlatform || ''))  return 'Coach';
  const t = (text || '').toLowerCase();
  const client = (t.match(/client app/g) || []).length * 3 + (t.match(/\bclients?\b/g) || []).length;
  const coach  = (t.match(/coach app/g)  || []).length * 3 + (t.match(/\bcoach(es)?\b/g) || []).length;
  if (client === 0 && coach === 0) return 'Coach';
  return client >= coach ? 'Client' : 'Coach';
}

async function inferPlatformFromAssignee(client, slackUserId, fallbackPlatform, contextText = '') {
  try {
    const info        = await client.users.info({ user: slackUserId });
    const profile     = info.user?.profile || {};
    const displayName = (profile.display_name || profile.real_name || '').toLowerCase();
    // profile.title may need users.profile:read scope — read it defensively
    let title = '';
    try { title = (profile.title || '').toLowerCase(); } catch (_) {}
    const haystack    = `${displayName} ${title}`;

    let bucket = null;

    // 0) Squad roster is the authoritative source — check both display and real name
    bucket = getRosterBucket(profile.display_name) || getRosterBucket(profile.real_name);
    if (bucket === 'fullstack' || bucket === 'qa') bucket = null; // keep LLM platform for these roles
    if (bucket) console.log(`[QABot] Roster match: ${profile.real_name || profile.display_name} → ${bucket}`);

    // 1) Everfit convention: parenthesized role tag in the display name, e.g. "Hong (BE)"
    const tagMatch = bucket ? null : haystack.match(/\(\s*(be|fe|backend|frontend|ios|android|web|dl|data|ba)\s*\)/i);   // tolerates "( DL )"
    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase();
      if      (tag === 'ba')                                            bucket = 'product'; // business analyst
      else if (tag === 'dl' || tag === 'data')                         bucket = 'data';   // data labelling
      else if (tag === 'be' || tag === 'backend')                      bucket = 'api';
      else if (tag === 'fe' || tag === 'frontend' || tag === 'web')    bucket = 'web';
      else if (tag === 'ios')                                          bucket = 'ios';
      else if (tag === 'android')                                      bucket = 'android';
    }

    // 2) Fall back to job title keywords (only if no tag was found)
    if (!bucket) {
      if      (/business analyst|product analyst|\bba\b/.test(title))  bucket = 'product';
      else if (/data label|data annotat|data entry/.test(title))         bucket = 'data';
      else if (/back[\s-]?end|api engineer|server engineer/.test(title)) bucket = 'api';
      else if (/front[\s-]?end|web engineer/.test(title))                bucket = 'web';
      else if (/\bios\b/.test(title))                                    bucket = 'ios';
      else if (/\bandroid\b/.test(title))                                bucket = 'android';
    }

    if (!bucket) return null;

    // If the assignee's bucket matches the LLM-parsed platform, keep the LLM platform —
    // this preserves the Coach vs Client distinction the LLM picked up from the thread.
    const fallbackBucket = getPlatformBucket(fallbackPlatform);
    if (bucket === fallbackBucket) return fallbackPlatform;

    // Mismatch → switch to the assignee's bucket. For mobile, decide Client
    // vs Coach from the original platform, then from the report wording
    // (client-app reports are common in the report channels).
    if (bucket === 'product') return 'Product';
    if (bucket === 'data')    return 'Data';
    if (bucket === 'api')     return 'API';
    if (bucket === 'web')     return 'Web';
    const side = mobileSide(fallbackPlatform, contextText);
    if (bucket === 'ios')     return `iOS ${side}`;
    if (bucket === 'android') return `Android ${side}`;
    return null;
  } catch (err) {
    console.warn(`[QABot] Could not infer platform for ${slackUserId}: ${err.message}`);
    return null;
  }
}

// ── Replace the first [Platform] block in a summary with a new platform ──
// LLM produces summaries like "[Android Coach][2FA] Locked Screen...";
// we swap the first bracketed block when the assignee's role overrides the platform.
function rewriteSummaryPrefix(summary, newPlatform) {
  const prefix = `[${newPlatform}]`;
  const PLATFORM_TAG = /\[(?:iOS|Android)(?: (?:Client|Coach))?\]|\[(?:API|Web|BE|FE|Backend|Frontend|Mobile|Data|Product)\]/i;
  // Replace the platform tag wherever it sits (it may follow [Client Report]);
  // never touch the leading [Client Report]/[Client Request] tag.
  if (PLATFORM_TAG.test(summary)) return summary.replace(PLATFORM_TAG, prefix);
  const lead = summary.match(/^(\[(?:client\s*report|client\s*request|request)\])/i);
  if (lead) return `${lead[1]}${prefix}${summary.slice(lead[1].length)}`;
  if (summary.startsWith('[')) return summary.replace(/^\[[^\]]+\]/, prefix);
  return `${prefix}${summary}`;
}

// ── Ensure summary always has [Platform][Feature] bracket format ──────────
// Guards against LLM returning plain-text platform, e.g.:
//   "Web[Video Upload] desc"   → "[Web][Video Upload] desc"
//   "iOS Client desc"          → "[iOS Client] desc"
//   "[Web][Video Upload] desc" → unchanged
//   "[Web] desc"               → unchanged (has platform at minimum)
function normalizeSummaryPrefix(summary, platform) {
  if (!summary) return `[${platform}] Bug report`;

  // Already has [Platform][Feature] → nothing to do
  if (/^\[[^\]]+\]\[[^\]]+\]/.test(summary)) return summary;

  // Already starts with a bracket → keep as-is
  if (summary.startsWith('[')) return summary;

  // Strip plain-text platform name from the front (e.g. "Web" or "iOS Client")
  const escaped = platform.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = summary.replace(new RegExp('^' + escaped + '\\s*', 'i'), '').trim();

  // If remainder starts with [Feature], join without space → [Platform][Feature] desc
  if (stripped.startsWith('[')) return `[${platform}]${stripped}`;
  return `[${platform}] ${stripped}`;
}

// ── Extract topic keywords from a Slack channel name ─────────────────────
// "assign-video-workouts" → ["video", "workouts"]
// "platform-capability-squad" → ["platform", "capability", "squad"]
function extractChannelKeywords(channelName) {
  return (channelName || '')
    .replace(/^(assign|qa|dev|bug|fix|report|channel|general|squad)-?/i, '')
    .split(/[-_]/)
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length > 2 && !['the','and','for','with','from'].includes(w));
}

// ── Find the best parent epic in the ACTIVE SPRINT ──────────────────────
// More reliable than canvas reading: always queries live Jira data.
// Filters by platform prefix, then ranks by keyword overlap with channel name.
// Significant words for judging whether an epic relates to a card: no
// platform names, no generic project words, no short words.
function epicRelevanceTokens(text) {
  const STOP = new Set(['web','ios','android','api','client','coach','app','apps','phase','enhance','enhancement',
    'update','improve','improvement','fixe','fix','issue','sprint','squad','all','core','misc',
    'product','feature','the','and','for','with','from','into','this','that','review','task']);
  const stem = (w) => w.replace(/ies$/, 'y').replace(/(?<=[a-z]{3})es$/, '').replace(/(?<=[a-z]{3})s$/, '');
  return new Set((text || '').toLowerCase().split(/[^a-z0-9]+/)
    .map(stem).filter(w => w.length >= 4 && !STOP.has(w) && !/^p\d/.test(w)));
}

async function findSprintParent(activeSprintId, platform, channelName, ticketSummary = '', ticketText = '', issueType = 'Bug') {
  if (!activeSprintId) return null;
  try {
    const platformPrefix = {
      'API':             'API',
      'Web':             'Web',
      'iOS Client':      'iOS',
      'iOS Coach':       'iOS',
      'Android Client':  'Android',
      'Android Coach':   'Android',
    }[platform] || platform.split(' ')[0];

    const jql =
      `project = UP AND issuetype = Epic AND sprint = ${activeSprintId} ORDER BY key DESC`;

    const res = await axios.get(`${JIRA_HOST}/rest/api/3/search/jql`, {
      params: { jql, maxResults: 60, fields: 'summary,status' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });

    const CLOSED = new Set(['qa success','done','closed','released','complete','completed','qa passed',"won't fix",'resolved','cancelled']);
    const issues = (res.data.issues || []).filter(i => {
      const t = (i.fields.summary || '').toLowerCase().trim();
      const st = (i.fields.status?.name || '').toLowerCase();
      return t.startsWith(platformPrefix.toLowerCase()) && !CLOSED.has(st);
    });

    if (issues.length === 0) return null;
    if (issues.length === 1) return issues[0].key;

    // Multiple candidates — rank by keyword overlap with channel name
    // Only take an epic that RELATES to this card. Previously the first
    // platform-prefixed epic won when nothing matched ("Web | Caching and
    // Loading Enhancement" for a PI-title review task). Unsure → null, and
    // the requester is asked to pick.
    const titleWordsCard = epicRelevanceTokens(ticketSummary);          // the card's title decides
    const cardWords = epicRelevanceTokens(`${ticketSummary} ${ticketText}`);
    const chanWords = extractChannelKeywords(channelName);
    let best = null, bestScore = 0;
    for (const issue of issues) {
      const title = (issue.fields.summary || '').toLowerCase();
      const isFixesBucket = /\bfixes\b/.test(title);
      if (isFixesBucket) {
        // Catch-all "… | Fixes of … | Sprint N" buckets suit BUGS only
        if (!/^bug$/i.test(issueType || '')) continue;
        const score = 1 + (/misc/.test(title) ? 0.5 : 0);
        if (score > bestScore) { bestScore = score; best = issue.key; }
        continue;
      }
      const epicWords = epicRelevanceTokens(title);
      // Must share a word with the card's TITLE (descriptions quote examples
      // and noise), and at least two with the card overall.
      const sharedTitle = [...epicWords].filter(w => titleWordsCard.has(w)).length;
      const shared = [...epicWords].filter(w => cardWords.has(w)).length;
      const chan = chanWords.filter(k => title.includes(k)).length * 0.5;
      const score = (sharedTitle >= 1 && shared >= 2) ? shared + sharedTitle + chan : 0;
      if (score > bestScore) { bestScore = score; best = issue.key; }
    }
    console.log(`[QABot] Sprint parent: ${best || 'none — will ask'} (score=${bestScore}, platform=${platform}, type=${issueType})`);
    return best;
  } catch (err) {
    console.warn('[QABot] findSprintParent failed:', err.message);
    return null;
  }
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

// ── Agent status: live progress message (agent-working feel) ──
// ── Conversational intelligence for QA Bot mentions ─────────────────
// Distinguishes "log this" from greetings/questions, and answers the
// latter like an assistant instead of dumping boilerplate (or worse,
// logging a ticket because someone said hello in a bug thread).
const QA_CAPABILITIES = `Your abilities:
• Tagged inside any bug/task thread → you read the whole thread and log it to Jira: Bug or Task auto-detected, correct Epic, Fix Version and the current Active Sprint set automatically
• "create task" forces a Task · "force log" logs even when the thread already has a ticket · including an epic key (UP-xxxx / PLAN-xxxx) parents the ticket to it
• In the client-report channels (bug_reporting-internal, enterprise_bug_reporting_internal, customer-request-discussion) you additionally auto-analyze every new report, create & assign cards from natural language ("assign to @dev", "giao cho @dev"), run follow-up tracking, and post weekly reports`;

// ── Agent router: gather context → AI decides the action ──
async function scanThreadTicketKeys(client, channelId, threadTs) {
  const keys = [];
  try {
    const replies = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 100 });
    const textOf = (m) => {
      const parts = [m.text || ''];
      for (const att of m.attachments || []) parts.push(att.title || '', att.text || '', att.fallback || '', att.title_link || '', att.from_url || '');
      const walk = (blocks) => { for (const b of blocks || []) { if (b.text && b.text.text) parts.push(b.text.text); if (b.url) parts.push(b.url); if (b.elements) walk(b.elements); if (b.fields) for (const f of b.fields) parts.push(f.text || ''); } };
      walk(m.blocks);
      return parts.join(' ');
    };
    for (const m of replies.messages || []) {
      for (const k of textOf(m).match(/\b(?:UP|PAY|AIT|CHAL)-\d+\b/g) || []) if (!keys.includes(k)) keys.push(k);
    }
  } catch (_) {}
  return keys;
}

async function agentRoute(userText, context, existingKeys) {
  try {
    const res = await aiComplete({
      model: SMART_MODEL, max_tokens: 60,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `You are the decision core of QA Agent, a Jira assistant in Slack. Users write English or Vietnamese. Decide ONE action for the user's mention. Return ONLY JSON: {"action":"log_ticket"|"follow_up"|"task"|"retract"|"answer"}

Actions:
- "log_ticket": user wants Jira ticket(s) CREATED from this thread \u2014 in any phrasing: "log this", "t\u1ea1o ticket", "l\u00ean card", "create card(s)", "create N tickets", "assign to @member" / "giao cho @member" (create-and-assign), or a bare tag in a thread with NO existing ticket
- "follow_up": user wants status/progress/tracking of the EXISTING ticket(s) in this thread ("follow up on this", "theo d\u00f5i", "status?", "track this", "any update", "check ti\u1ebfn \u0111\u1ed9", "nh\u1eafc dev gi\u00fap")
- "task": work whose OUTPUT IS A SLACK MESSAGE \u2014 summarize, list/extract items, draft a message/announcement/release note, translate, compare, plan tests, review, write documentation, analyze in depth ("summary all demo items", "t\u00f3m t\u1eaft thread n\u00e0y", "draft the announcement", "extract action items"). NEVER choose "task" when the user wants tickets/cards created, assigned, or updated in Jira \u2014 that is "log_ticket". If a message mentions BOTH (e.g. "review these issues and create cards"), the Jira action wins: choose "log_ticket".
- "retract": user asks the BOT to delete/remove its own previous message ("delete this response", "delete your last message", "xóa tin nhắn đó", "remove that reply")
- "answer": greeting, short question, quick opinion — brief conversational replies only

CRITICAL RULE: Existing tickets in thread: ${existingKeys.length ? existingKeys.join(', ') : 'NONE'}.
If tickets already exist, "log_ticket" is almost never right \u2014 requests mentioning the issue, tracking, or checking route to "follow_up". Only choose "log_ticket" despite existing tickets if the user EXPLICITLY asks for a new/additional/separate ticket.
A bare tag (empty message) with existing tickets \u2192 "follow_up". A bare tag with none \u2192 "log_ticket".` },
        { role: 'user', content: `User message: ${userText || '(bare tag, no text)'}\n\nThread (truncated):\n${(context || '').substring(0, 2000)}` },
      ],
    });
    const parsed = JSON.parse(res.choices[0].message.content || '{}');
    return ['log_ticket', 'follow_up', 'task', 'retract', 'answer'].includes(parsed.action) ? parsed.action : 'log_ticket';
  } catch { return 'log_ticket'; } // on failure, original behavior
}


// ── General task worker: QA Agent does ANY requested knowledge work ──
async function qaChatReply(context, userText) {
  try {
    const res = await aiComplete({
      model: SMART_MODEL, max_tokens: 350,
      messages: [
        { role: 'system', content: `You are QA Agent, Everfit's autonomous QA assistant living in Slack. Speak in first person, like a capable colleague — never refer to yourself as a bot.\n${QA_CAPABILITIES}\n\nAnswer the user conversationally and helpfully in ENGLISH only, 1-4 sentences. If they greet you or ask what you can do, summarize your abilities naturally (not as a bullet dump). Ground answers in the thread context when relevant. Never invent ticket numbers or statuses.` },
        { role: 'user', content: `Thread context:\n${(context || '(no thread)').substring(0, 2500)}\n\nUser message: ${userText}` },
      ],
    });
    return lib.slackify(res.choices[0].message.content?.trim()) || null;
  } catch { return null; }
}

const coreMentionHandlerInner = async ({ event, client, logger, _cleanups = [] }) => {
  // Client-report channels are handled by the client-report module
  // Monitored (client-report) channels own their specialised flows —
  // EXCEPT ticket creation, which runs through this one proven pipeline in
  // every channel. Same prompt, same parsers, same behavior everywhere.
  // Bulk admin command: "move all tickets from this channel to epic UP-x".
  // Edits many cards at once, so it's limited to BULK_ADMINS (default: Thanh).
  const bulkText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const bulkMatch = bulkText.match(lib.BULK_MOVE_RE);
  if (bulkMatch) {
    const epicKey = bulkMatch[1].toUpperCase();
    const tTs = event.thread_ts || event.ts;
    const admins = new Set((process.env.BULK_ADMINS || 'U0142GU335F').split(',').map(s => s.trim()));
    if (!admins.has(event.user)) {
      await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: "Moving a whole channel's cards is limited to admins — ask Thanh to run it." });
      return;
    }
    const st = agentStatus(client, event.channel, tTs);
    await st.start(`I'm moving this channel's cards to ${epicKey}`);
    try {
      const r = await lib.bulkSetParentForChannel(event.channel, epicKey, {
        onProgress: (n, total) => st.update(`I'm moving this channel's cards to ${epicKey} (${n}/${total})`),
      });
      await st.done();
      const title = (await lib.getIssueTitle(epicKey)) || epicKey;
      const failLines = r.failed.slice(0, 10).map(f => `• ${f.key}: ${String(f.reason).substring(0, 120)}`).join('\n');
      await client.chat.postMessage({
        channel: event.channel, thread_ts: tTs, unfurl_links: false,
        text: r.total === 0
          ? `Nothing to move — every card from this channel is already under <${JIRA_HOST}/browse/${epicKey}|${title}>.`
          : `Moved *${r.moved.length}* of ${r.total} card(s) from this channel to <${JIRA_HOST}/browse/${epicKey}|${title}>.` +
            (r.failed.length ? `\n${r.failed.length} couldn't be moved:\n${failLines}` : ''),
      });
      logger.info(`[QAAgent] Bulk parent → ${epicKey}: moved ${r.moved.length}/${r.total}, failed ${r.failed.length}`);
    } catch (err) {
      await st.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: `I couldn't finish moving the cards: \`${(err.message || '').substring(0, 200)}\`` });
    }
    return;
  }

  // Bulk create: "create tickets under each thread without a ticket".
  // Admin-only; shows the count and asks for confirmation before creating.
  if (lib.isBulkCreateRequest(event.text)) {
    const tTs = event.thread_ts || event.ts;
    const admins = new Set((process.env.BULK_ADMINS || 'U0142GU335F').split(',').map(s => s.trim()));
    if (!admins.has(event.user)) {
      await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: 'Creating cards for a whole channel is limited to admins — ask Thanh to run it.' });
      return;
    }
    const daysMatch = (event.text || '').match(/\b(\d{1,3})\s*(?:days?|ngày)\b/i);
    const days = daysMatch ? Math.min(parseInt(daysMatch[1], 10), 365) : 120;
    const st = agentStatus(client, event.channel, tTs);
    await st.start("I'm finding issue posts without a ticket");
    let r;
    try {
      const botUserId = (await client.auth.test()).user_id;
      r = await lib.findThreadsWithoutTickets(client, event.channel, { days, botUserId });
    } catch (err) {
      await st.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: `I couldn't check the channel: \`${(err.message || '').substring(0, 200)}\`` });
      return;
    }
    await st.done();
    if (!r.missing.length) {
      await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: `Every issue post from the last ${days} days already has a ticket — nothing to create.` });
      return;
    }
    const id = `${Date.now()}`;
    BULK_CREATE_JOBS.set(id, { channel: event.channel, tsList: r.missing.map(p => p.ts), by: event.user, statusTs: null, threadTs: tTs });
    const preview = r.missing.slice(0, 10).map(p => `• <https://everfitt.slack.com/archives/${event.channel}/p${p.ts.replace('.', '')}|${lib.postLabel(p.text)}>`).join('\n');
    await client.chat.postMessage({
      channel: event.channel, thread_ts: tTs, unfurl_links: false, unfurl_media: false,
      text: `I found ${r.missing.length} issue posts without a ticket.`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `I found *${r.missing.length}* issue posts from the last ${days} days without a ticket. I'll create one card in each thread and reply there.\n${preview}${r.missing.length > 10 ? `\n_…and ${r.missing.length - 10} more._` : ''}` } },
        { type: 'actions', elements: [
          { type: 'button', style: 'primary', action_id: 'qa_bulk_create_go', value: id, text: { type: 'plain_text', text: `Create ${r.missing.length} tickets` } },
          { type: 'button', action_id: 'qa_bulk_create_cancel', value: id, text: { type: 'plain_text', text: 'Cancel' } },
        ] },
      ],
    });
    return;
  }

  // Report: "which threads have no ticket?" — read-only, anyone can ask.
  if (lib.isNoTicketReportRequest(event.text)) {
    const tTs = event.thread_ts || event.ts;
    const daysMatch = (event.text || '').match(/\b(\d{1,3})\s*(?:days?|ngày)\b/i);
    const days = daysMatch ? Math.min(parseInt(daysMatch[1], 10), 365) : 120;
    const st = agentStatus(client, event.channel, tTs);
    await st.start("I'm checking this channel's issue posts against Jira");
    try {
      const botUserId = (await client.auth.test()).user_id;
      const r = await lib.findThreadsWithoutTickets(client, event.channel, { days, botUserId });
      await st.done();
      const link = (ts) => `https://everfitt.slack.com/archives/${event.channel}/p${ts.replace('.', '')}`;
      const date = (ts) => new Date(parseFloat(ts) * 1000 + 7 * 3600 * 1000).toISOString().substring(0, 10);
      const firstLine = (t) => lib.postLabel(t);
      const shown = r.missing.slice(0, 40);
      const lines = shown.map(p => `• ${date(p.ts)} · <@${p.user}> · <${link(p.ts)}|${firstLine(p.text) || 'post'}>`).join('\n');
      await client.chat.postMessage({
        channel: event.channel, thread_ts: tTs, unfurl_links: false, unfurl_media: false,
        text: r.missing.length === 0
          ? `Every issue post from the last ${days} days has a ticket (${r.scanned} checked).`
          : `*${r.missing.length}* of ${r.scanned} issue posts from the last ${days} days have no ticket:\n${lines}` +
            (r.missing.length > shown.length ? `\n_…and ${r.missing.length - shown.length} more._` : '') +
            `\n_Checked both ways: Jira cards linking back to the thread, and card keys or Jira links in the thread._`,
      });
    } catch (err) {
      await st.done();
      await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: `I couldn't finish the check: \`${(err.message || '').substring(0, 200)}\`` });
    }
    return;
  }

  // Release coordination: "draft release for Web 4.37.1" / "release plan"
  if (release.isReleaseCommand(event.text)) {
    await release.handleCommand({ event, client, logger });
    return;
  }

  // Logs: "@QA Agent logs" / "logs analyze" / "show logs for UP-79340"
  const logsMatch = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim().match(/^(?:(?:show|check|get)\s+(?:the\s+)?(?:bot\s+)?logs?|logs)\b(?:\s+(?:for|about|with|of)?\s*(.+))?$/i);
  if (logsMatch) {
    const tTs = event.thread_ts || event.ts;
    const admins = new Set((process.env.LOG_ADMINS || 'U0142GU335F,U0445EQS1ED').split(',').map(s => s.trim()));
    if (!admins.has(event.user)) {
      await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, text: 'Logs can include names and emails, so they are limited to admins.' });
      return;
    }
    const filter = (logsMatch[1] || '').trim().toLowerCase();
    const words = filter ? filter.split(/\s+/).filter(Boolean) : [];
    const matching = LOG_RING.filter(l => !words.length || words.every(w => l.toLowerCase().includes(w)));
    const picked = [];
    let size = 0;
    for (let k = matching.length - 1; k >= 0 && picked.length < 60; k--) {        // newest first, then show in order
      const line = matching[k].replace(/xox[abp]-[\w-]+/g, 'xox…').replace(/\bsk-[\w-]{6,}/g, 'sk-…');
      if (size + line.length > 3400) break;
      picked.unshift(line); size += line.length + 1;
    }
    await client.chat.postMessage({
      channel: event.channel, thread_ts: tTs, unfurl_links: false, unfurl_media: false,
      text: picked.length
        ? `Last ${picked.length} log line${picked.length > 1 ? 's' : ''}${filter ? ` matching "${filter}"` : ''} (build \`${BUILD}\`, since ${new Date(BOOT_AT + 7 * 3600 * 1000).toISOString().substring(5, 16).replace('T', ' ')} VN):\n\`\`\`\n${picked.join('\n')}\n\`\`\``
        : `No log lines${filter ? ` matching "${filter}"` : ''} since the last restart (${new Date(BOOT_AT + 7 * 3600 * 1000).toISOString().substring(5, 16).replace('T', ' ')} VN).`,
    });
    return;
  }

  // Health self-report: '@QA Agent status' / 'are you alive'
  if (/^(status|health|are you (alive|ok|up)|ping)\b/i.test((event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim())) {
    const up = Math.round((Date.now() - BOOT_AT) / 1000);
    const mem = process.memoryUsage();
    const upStr = up > 3600 ? `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m` : `${Math.floor(up / 60)}m ${up % 60}s`;
    const errs = RECENT_ERRORS.slice(0, 3).map(e => `• ${e.at.substring(11, 19)} ${e.where}: ${e.msg.substring(0, 120)}`).join('\n');
    await client.chat.postMessage({
      channel: event.channel, thread_ts: event.thread_ts || event.ts, unfurl_links: false,
      text:
        `I'm alive.\n` +
        `• build \`${BUILD}\` · up ${upStr} · rss ${Math.round(mem.rss / 1048576)}MB\n` +
        `• AI: ${process.env.OPENAI_BASE_URL ? new URL(process.env.OPENAI_BASE_URL).host : 'api.openai.com'} · smart ${process.env.OPENAI_SMART_MODEL || 'gpt-4o'} · fallback ${process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini'}\n` +
        (errs ? `• recent errors:\n${errs}` : `• no errors recorded since boot`),
    });
    return;
  }

  if (clientReport.MONITORED_CHANNELS[event.channel] && !lib.isCreationRequest(event.text) && !lib.isDiscoveryRequest(event.text)) return;
  if (clientReport.MONITORED_CHANNELS[event.channel]) {
    logger.info(`[QAAgent] Creation request in monitored channel ${clientReport.MONITORED_CHANNELS[event.channel]} — using core pipeline`);
  }


  // Post the live status FIRST — before auth.test / thread reads — so a
  // silent thread always means "the handler never ran" (event not
  // delivered, or the process is down), never "it ran and vanished".
  // Retract runs BEFORE any status is posted: it's instant, and a status
  // message here would either be deleted as "my last message" or left
  // orphaned in the thread.
  if (lib.FASTPATH.retract.test(event.text)) {
    const tTs = event.thread_ts || event.ts;
    try {
      const deleted = await lib.retractOwnMessages(client, event.channel, tTs, event.text, { beforeTs: event.ts });
      if (!deleted) {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: tTs, unfurl_links: false,
          text: "I don't have a message of mine in this thread to delete.",
        });
      } else {
        logger.info(`[QAAgent] Retract: deleted ${deleted} own message(s)`);
      }
    } catch (err) {
      logger.warn('[QAAgent] Retract failed:', err.data?.error || err.message);
    }
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
    return;
  }

  const bootSt = agentStatus(client, event.channel, event.thread_ts || event.ts);
  _cleanups.push(() => bootSt.done());
  await bootSt.start("I'm on it");

  const authRes   = await client.auth.test();
  const botUserId = authRes.user_id;
  const botBotId  = authRes.bot_id;
  const threadTs  = event.thread_ts || event.ts;

  // Detect "force log" command
  const triggerText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();
  const isForceLog  = triggerText.startsWith('force log') || triggerText.startsWith('force');

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  // Declared OUTSIDE the try so catch blocks can always clean the status up
  // (a catch referencing a try-scoped const threw 'agentSt is not defined'
  // and MASKED every real error).
  let agentSt = null;
  try {
    // Fetch thread context first — needed for AI classification below
    let context;
    if (event.thread_ts) {
      context = await getThread(client, event.channel, event.thread_ts);
    } else {
      context = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    }

    if (!context || context.trim().length < 10) {
      const reply = await qaChatReply('', event.text.replace(/<@[A-Z0-9]+>/g, '').trim());
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts, unfurl_links: false,
        text: reply || "👋 I'm QA Agent — drop me into any bug or task thread and I'll take it from there: log it to Jira with the right Epic, Fix Version and Active Sprint, follow up on existing tickets, or answer questions. What do you need?",
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'speech_balloon', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Agent decision: what does the user actually want? ──
    // Explicit commands skip the router: force log / create task always log.
    if (!isForceLog && !/^create\s?(task|ticket)/.test(triggerText)) {
      const existingKeys = await scanThreadTicketKeys(client, event.channel, threadTs);
      // Deterministic fast-path: explicit ticket-creation/assignment language
      // is ALWAYS a log request — never let the AI router reinterpret it as
      // a summary/task (real incident: 'create card and assign to @X' got
      // routed to task and produced a summary).
      // Deterministic fast-path: explicit ticket-creation/assignment language
      // goes straight to the battle-tested creation pipeline (multi-ticket,
      // dedup buttons, epic parenting, attachments).
      const wantsTicket = lib.FASTPATH.creation.test(event.text) || lib.FASTPATH.assignMention.test(event.text);

      // ── Discovery board (PLAN / product discovery) ──────────────
      // "log this into the Core Discovery board", "create a PLAN item",
      // "update this into PLAN-123" — deterministic, never model-routed.
      if (lib.isDiscoveryRequest(event.text)) {
        const existingPlan = (event.text.match(/\bPLAN-\d+\b/i) || [])[0]?.toUpperCase() || null;
        await bootSt.update(existingPlan ? `I'm updating ${existingPlan}` : "I'm drafting the discovery item");

        const participants = [...new Set((context.match(/^\[([^\]]+)\]/gm) || []).map(s => s.replace(/^\[|\]$/g, '')))].slice(0, 8);
        // Strip everything addressed to/from the agent — commands like
        // "log this", "create a task", "assign to me" are NOT product content.
        const productContext = (context || '').split('\n')
          .filter(l => !/@QA Agent|^\[QA Agent\]/i.test(l))
          .join('\n');

        // Paste-through: if the request (or the latest thread message) already
        // contains a written product item (markdown headings), file it as-is.
        // Authoring happens with Claude; the agent only files it.
        const reqBody = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
        let pasted = null;
        if (/##\s+\S/.test(reqBody) && reqBody.length > 300) {
          pasted = reqBody.substring(reqBody.indexOf('##'));
        } else if (/\b(with this|use this|this draft|draft above|the above)\b/i.test(reqBody)) {
          try {
            const rr = await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 100 });
            const cand = (rr.messages || [])
              .filter(m => !m.bot_id && m.ts !== event.ts && /##\s+\S/.test(m.text || '') && (m.text || '').length > 300)
              .sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))[0];
            if (cand) pasted = cand.text.substring(cand.text.indexOf('##'));
          } catch (_) {}
        }

        let draftRaw;
        if (pasted) {
          const titleLine = (pasted.match(/^#\s+(.+)$/m) || [])[1];
          draftRaw = JSON.stringify({ summary: titleLine || null, description: pasted, thin: false, verbatim: true });
          logger.info('[QAAgent] Discovery: filing pasted draft verbatim');
        } else draftRaw = await lib.aiCall(
          `You CAPTURE a product signal from a Slack thread into an Everfit Product Item skeleton for the Jira Product Discovery board. You are NOT the author — a PM will write the full item later. Your only job is to record faithfully what the thread actually says.

Return ONLY a json object: {"summary":"...","description":"...","thin":true|false}

summary: short neutral title of the idea, <=80 chars (e.g. "Loom integration").

description — markdown with these five headings, in order:
## Problem / Context
## Goals
## Desired outcome
## References
## Open Questions

HARD RULES — follow exactly:
- Fill a section ONLY with information explicitly stated in the thread. Attribute it ("Long Nguyen: …"), keep the speaker's meaning, quote short phrases where useful.
- If the thread does not support a section, put exactly one bullet under it: "- [To be written]". Do NOT infer, generalize, or write plausible-sounding goals/outcomes. An honest gap beats invented content.
- Record signals exactly as stated: "Medium since it is currently done via in-chat" = priority Medium, reason: existing in-chat workaround. Never convert priority into effort or vice versa.
- References: always render "- **Design:**", "- **Technical Solution Document:**", "- **PRD:**", "- **Specification:**" (empty values unless a link is in the thread).
- Open Questions: a table "| Questions | Owner | Answer |" listing what the thread leaves unknown (at least 2).
- IGNORE any message that is an instruction to a bot or about logging/creating/assigning tickets.
- thin: true if Goals or Desired outcome is "[To be written]".
- English only.`,
          `Thread transcript (bot commands removed):\n${productContext.substring(0, 8000)}`,
          2000, true, 'gpt-4o', 60000,
        );
        let draft;
        try {
          const j = draftRaw.substring(draftRaw.indexOf('{'), draftRaw.lastIndexOf('}') + 1);
          draft = JSON.parse(j);
        } catch (e) {
          throw new Error(`couldn't draft the discovery item: ${e.message}`);
        }

        const threadUrl = buildSlackThreadUrl(event.channel, threadTs);
        // Put the Slack thread under References as extra evidence (the
        // template keeps the four fixed labels first).
        let body = draft.description || '';
        if (/## References/i.test(body)) {
          body = body.replace(/(## References[\s\S]*?\*\*Specification:\*\*[^\n]*)/i, `$1\n- **Slack discussion:** ${threadUrl}`);
          if (!body.includes(threadUrl)) body = body.replace(/(## References[^\n]*\n)/i, `$1- **Slack discussion:** ${threadUrl}\n`);
        } else {
          body += `\n\n## References\n- **Slack discussion:** ${threadUrl}`;
        }
        const commentMd =
          `Updated from the Slack thread discussion.\n` +
          (participants.length ? participants.map(p => `- ${p}`).join('\n') + '\n' : '') +
          `${(draft.description || '').split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ')}`.substring(0, 900);

        if (existingPlan) {
          // Jira Product Discovery: only 'Creator' roles can edit ideas.
          // Contributors can create + comment, but the description is not
          // on their edit screen ("Field 'description' cannot be set").
          // Fall back to posting the content as a comment, honestly.
          let descUpdated = true;
          try {
            await lib.updateIssueDescription(existingPlan, body);
          } catch (e) {
            const msg = JSON.stringify(e.response?.data || e.message);
            if (/cannot be set|not on the appropriate screen/i.test(msg)) {
              descUpdated = false;
              logger.warn(`[QAAgent] ${existingPlan} description not editable (JPD permissions) — posting as comment`);
              await lib.addIssueComment(existingPlan, `Proposed description (couldn't edit it directly — my account can't edit discovery ideas):\n\n${body}`);
            } else throw e;
          }
          if (descUpdated) await lib.addIssueComment(existingPlan, commentMd);
          await bootSt.done();
          if (!descUpdated) {
            await client.chat.postMessage({
              channel: event.channel, thread_ts: threadTs, unfurl_links: false,
              text: `I couldn't edit <${JIRA_HOST}/browse/${existingPlan}|${existingPlan}>'s description — on discovery boards only *Creator* roles can edit ideas, and my Jira account is a Contributor. I posted the new content as a comment instead so you can copy it into the description. A JPD admin can grant my account the Creator role to fix this permanently.`,
            });
            await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
            await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
            return;
          }
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs, unfurl_links: false,
            text: draft.verbatim
              ? `📝 Updated <${JIRA_HOST}/browse/${existingPlan}|${existingPlan}> with your draft — filed verbatim, plus a comment linking this thread.`
              : `📝 Updated <${JIRA_HOST}/browse/${existingPlan}|${existingPlan}> from this thread — description refreshed and a summary comment added.${draft.thin ? ' Some sections are [To be written] — the thread doesn\'t cover them.' : ''}`,
          });
        } else {
          if (!draft.summary) draft.summary = (productContext.split('\n')[0] || 'Product idea').replace(/^\[[^\]]+\]:\s*/, '').substring(0, 80);
          const created = await lib.createDiscoveryItem({ summary: draft.summary, descriptionMarkdown: body });
          await lib.addIssueComment(created.key, commentMd).catch(() => {});
          await bootSt.done();
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs, unfurl_links: false,
            text:
              `💡 Logged to the discovery board → <${created.url}|${created.key}>\n` +
              `*${draft.summary}*\n` +
              (draft.thin
                ? `_I captured what the thread says; Goals / Desired outcome are marked [To be written] — the thread doesn't cover them. Draft the full item with Claude, then paste it here with "update ${created.key} with this" and I'll file it verbatim._\n`
                : '') +
              `_${created.type} in ${lib.DISCOVERY_PROJECT}${created.notes?.length ? ` · ${created.notes.join(' · ')}` : ''}. Mention ${created.key} anytime to update it from a thread._`,
          });
        }
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Deterministic retract fast-path: deleting my own messages must never
      // depend on a model or on the gateway supporting tools.
      logger.info(`[QAAgent] route: wantsTicket=${wantsTicket} existing=[${existingKeys.join(',')}] text="${triggerText.substring(0, 70)}"`);
      if (!wantsTicket) {
        // ── THE AGENT LOOP ──
        // Everything that isn't an explicit create request goes to the real
        // agent: tools + iterative decisions (read channel, search Jira,
        // create/assign/transition/comment, follow-ups, retract) until done.
        const agentLoopSt = agentStatus(client, event.channel, threadTs);
        _cleanups.push(() => agentLoopSt.done());
        await agentLoopSt.start('🤖 _QA Agent is on it…_');
        let result = null;
        try {
          result = await runAgent({
            client, logger,
            channelId: event.channel,
            threadTs,
            requesterId: event.user,
            requesterName: await resolveUserName(client, event.user),
            requestText: event.text.replace(/<@[A-Z0-9]+>/g, '').trim() || '(bare tag — read the thread and do the most useful thing: log it if it is an unlogged bug/task report, otherwise summarize status)',
            threadContext: context,
            existingKeys,
            status: agentLoopSt,
            registerFollowUp: clientReport.registerFollowUp,
          });
        } catch (err) {
          logger.warn('[Agent] loop failed:', err.message);
        }
        await agentLoopSt.done();
        if (!(result && result.__silent)) {
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs, unfurl_links: false,
            text: (typeof result === 'string' && result) || 'I ran into an error and could not finish — try again in a moment.',
          });
        }
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
        return;
      }
      logger.info('[QAAgent] Fast-path: ticket-creation language detected → creation pipeline');
    }

    await bootSt.done();
    agentSt = agentStatus(client, event.channel, threadTs);
    _cleanups.push(() => agentSt.done());
    await agentSt.start('⏳ _Dispatching to QA Agent — reading the thread…_');

    // Classify Bug vs Task — explicit keyword wins; otherwise AI decides from thread content
    await agentSt.update('🧠 _QA Agent is identifying Bug vs Task…_');
    let issueType = await classifyIssueType(triggerText, context);
    // Explicit issue-type mention overrides Bug/Task classification:
    // "create a Product Task for..." → issue type "Product Task" (the list
    // comes from Jira itself, so any type the project has just works).
    const availableTypes = await lib.getProjectIssueTypes();
    const explicitType = availableTypes
      .filter(t => !/^(bug|task)$/i.test(t))
      .sort((a, b) => b.length - a.length)
      .find(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`, 'i').test(event.text));
    if (explicitType) issueType = explicitType;
    const isTask = issueType !== 'Bug';   // non-Bug types use the task parser + skip dup-guard
    logger.info(`[QABot] Issue type: ${issueType}${explicitType ? ' (explicit)' : ' (classified)'}`);

    // ── Feature 2: Duplicate detection ──────────
    // Scan thread for existing QABot tickets
    const existingKeys = [];
    const existingSummaries = [];
    try {
      const threadResult = await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 50 });
      for (const msg of (threadResult.messages || [])) {
        if (msg.bot_id !== botBotId) continue;
        const keyMatches = (msg.text || '').match(/\b(?:UP|PAY|AIT|CHAL)-\d+\b/g) || [];
        existingKeys.push(...keyMatches);
        const summaryMatch = (msg.text || '').match(/\*(.+?)\*/);
        if (summaryMatch) existingSummaries.push(summaryMatch[1].toLowerCase());
      }
    } catch (_) {}

    // If tickets already exist and NOT force log → notify and ask
    // Skip duplicate detection for explicit Task creation — user is intentionally creating a new ticket
    if (existingKeys.length > 0 && !isForceLog && !isTask) {
      const ticketLinks = [...new Set(existingKeys)].map(k => `<${JIRA_HOST}/browse/${k}|${k}>`).join(', ');
      await agentSt.done();
      const value = JSON.stringify({ c: event.channel, t: threadTs, x: event.text.substring(0, 1100) });
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs, unfurl_links: false,
        text: `This thread already has ${ticketLinks} — what should I do?`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `This thread already has ${ticketLinks}.\nThreads often cover several issues — tell me how to proceed:` } },
          { type: 'actions', elements: [
            { type: 'button', style: 'primary', action_id: 'qa_core_dup_remaining', value,
              text: { type: 'plain_text', text: '🧩 Cover remaining issues', emoji: true } },
            { type: 'button', action_id: 'qa_core_dup_force', value,
              text: { type: 'plain_text', text: '🆕 Log new ticket anyway', emoji: true } },
            { type: 'button', action_id: 'qa_core_dup_follow', value,
              text: { type: 'plain_text', text: '🔍 Follow up on existing', emoji: true } },
            { type: 'button', style: 'danger', action_id: 'qa_core_dup_cancel', value,
              text: { type: 'plain_text', text: '✖️ Cancel', emoji: true } },
          ] },
        ],
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Feature 1: Parse — returns array of tickets ──
    // App Icon requests get a specialized parser with a fixed description template
    const userDirective = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    const tickets = isTask && isAppIconRequest(context)
      ? await parseAppIconRequest(context)
      : isTask
        ? await parseTaskReport(context, userDirective)
        : await parseBugReport(context, userDirective);
    const beforeDedup = tickets.length;
    const dedupedTickets = dedupeTickets(tickets);
    if (dedupedTickets.length < beforeDedup) {
      logger.info(`[QABot] Deduped ${beforeDedup} → ${dedupedTickets.length} ticket(s)`);
    }
    tickets.length = 0;
    tickets.push(...dedupedTickets);
    logger.info(`[QABot] Parsed ${tickets.length} ${issueType.toLowerCase()}(s)`);

    // Guard: LLM returned an empty array — nothing to create
    if (tickets.length === 0) {
      await agentSt.done();
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text:
          `I read through the thread but couldn't find a clear ${issueType.toLowerCase()} to log — it looks like mostly discussion. ` +
          `Add a message describing the issue or request, then tag me again and I'll take it from there.`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'warning', timestamp: event.ts }).catch(() => {});
      return;
    }

    // Detect assignees from trigger message.
    // Mentions after "cc" or "fyi" are informational only — NOT assignees.
    // e.g. "assign to @A cc @B"  → assignee A only
    //      "assign to @A, @B"    → assignees A and B (one card each)
    const ccMatch = event.text.match(/\b(?:cc|fyi)\b/i);
    const assignPortion = ccMatch
      ? event.text.slice(0, ccMatch.index)
      : event.text;
    const triggerMentions = (assignPortion.match(/<@([A-Z0-9]+)>/g) || [])
      .map(m => m.replace(/<@|>/g, ''))
      .filter(id => id !== botUserId);
    // "assign to me" / "giao cho em|mình|tôi" (no @mention) → the requester
    if (triggerMentions.length === 0 && /\b(assign|giao)\b[^.<\n]{0,30}\b(to\s+)?(me|myself|em|mình|tôi)\b/i.test(event.text)) {
      triggerMentions.push(event.user);
      logger.info('[QAAgent] Self-assign detected → assigning to requester');
    }
    if (ccMatch) {
      logger.info(`[QABot] cc/fyi detected — assignees limited to mentions before "${ccMatch[0]}"`);
    }

    // Parse Epic from trigger message (PLAN-XXX or UP-XXX)
    const epicExplicit = event.text.match(/\b(?:epic|under|parent)\s+(?:epic\s+)?(PLAN-\d+|UP-\d+|PAY-\d+|AIT-\d+|CHAL-\d+)\b/i);
    const epicAny      = event.text.match(/\b(PLAN-\d+|UP-\d+|PAY-\d+|AIT-\d+|CHAL-\d+)\b/i);
    let epicKey        = (epicExplicit ? epicExplicit[1] : epicAny ? epicAny[1] : null)?.toUpperCase() || null;
    // A card can only go under an EPIC. Check the named key first: if it's
    // another card, say so and offer its epic in the picker — never guess.
    let epicNamed = !!epicExplicit, epicRejected = null;
    if (epicKey && !/^PLAN-/i.test(epicKey)) {
      const cand = await lib.resolveEpicCandidate(epicKey);
      if (!cand.ok) {
        if (epicExplicit) epicRejected = cand;           // requester asked for it → explain + ask
        logger.info(`[QABot] ${epicKey} is not an epic (${cand.type || 'not found'})${cand.epicOfIt ? `; its epic is ${cand.epicOfIt.key}` : ''}`);
        epicKey = null;
      }
    }

    // "same epic as that previous bug/ticket" → inherit the epic from a
    // ticket already in this thread (no key typed in the message).
    if (!epicKey && /\b(same|previous|that|existing|cùng)\b[^.]{0,40}\b(epic|bug|ticket|card|task)\b/i.test(event.text)) {
      const threadKeys = await scanThreadTicketKeys(client, event.channel, threadTs);
      for (const k of threadKeys) {
        const inherited = await lib.getIssueEpic(k);
        if (inherited) {
          epicKey = inherited.toUpperCase();
          logger.info(`[QABot] Inherited epic ${epicKey} from ${k} in thread`);
          break;
        }
      }
      if (!epicKey) logger.info('[QABot] Epic inheritance requested but no epic found on thread tickets');
    }

    // Hardcoded fix version = "To be confirmed" (ID 12023)
    // Report channels keep the client-report convention ("Client Report (TBD)");
    // everywhere else uses the default "To be confirmed".
    // Channel profile: the CS channels use client-report conventions; the
    // production-issues channel has its own prefix and epic.
    const chProfile       = clientReport.channelProfile(event.channel);
    const inReportChannel = chProfile?.kind === 'client-report';
    const inProdAudit     = chProfile?.kind === 'production-audit';
    const fixVersionId = inReportChannel ? clientReport.CLIENT_REPORT_FIX_VERSION_ID : '12023';

    // Squad-owned projects: Payment & Billing / Booking → PAY, AI Features →
    // AIT. Only Core squads stay in UP. Report channels only.
    let targetProject = JIRA_PROJECT, projectRoute = null;
    if (inReportChannel) {
      const threadSquad = await clientReport.squadForThread(client, event.channel, threadTs);
      projectRoute = threadSquad ? clientReport.SQUAD_PROJECTS[threadSquad] || null : null;
      if (projectRoute) targetProject = projectRoute.project;
      logger.info(`[QABot] Squad "${threadSquad || 'unknown'}" → project ${targetProject}`);
    }
    // Challenger app → CHAL board, from any channel. Checked last so it wins
    // over the squad routing above.
    if (lib.isChallengerRequest(event.channel, `${event.text || ''}\n${context || ''}`)) {
      targetProject = lib.CHALLENGER_PROJECT;
      projectRoute  = { project: lib.CHALLENGER_PROJECT, parent: null, challenger: true };
      logger.info('[QABot] Challenger app → project CHAL');
    }
    const ticketFixVersionId = projectRoute?.challenger ? null        // CHAL doesn't use Fix Versions
      : projectRoute ? await lib.getMonthlyTbdVersion(targetProject) : fixVersionId;

    // Resolve reporter: the person who tagged the bot (NOT the thread author)
    const reporterSlackId = event.user;
    const reporterJiraId = await resolveJiraAccountId(client, reporterSlackId);
    logger.info(`[QABot] Reporter/QA set to: ${reporterSlackId} → Jira ${reporterJiraId || 'not found'}`);

    const slackThreadUrl = buildSlackThreadUrl(event.channel, threadTs);
    const tAtt = Date.now();
    const { attachments, skipped: skippedAtts } = await getAllThreadAttachments(client, event.channel, threadTs);
    // Download each file ONCE, max 2 at a time. Fully parallel downloads of
    // up to 8 x 15MB files can OOM a small container and kill the bot for
    // everyone — bounded concurrency keeps peak memory predictable.
    for (let i = 0; i < attachments.length; i += 2) {
      await Promise.all(attachments.slice(i, i + 2).map(async (att) => {
        try { att.buffer = await downloadSlackFile(att.url); }
        catch (err) { logger.warn(`[QABot] Attachment download failed (${att.name}):`, err.message); }
      }));
    }
    logger.info(`[QABot] Attachments ready: ${attachments.filter(a => a.buffer).length}/${attachments.length} in ${((Date.now() - tAtt) / 1000).toFixed(1)}s${skippedAtts.length ? ` · ${skippedAtts.length} skipped (too large)` : ''}`);
    const sprintId       = await getActiveSprintId();
    // Every board runs its own sprints (PAY → Payment NN, AIT → AINN,
    // CHAL → Challenger N): the card joins ITS project's active sprint.
    const targetSprint = targetProject === JIRA_PROJECT
      ? (sprintId ? { id: sprintId, name: lib.getLastActiveSprint()?.name || null } : null)
      : await lib.getActiveSprintForProject(targetProject);
    logger.info(`[QABot] Active sprint: ${sprintId || 'none found — ticket will not be added to a sprint'}`);

    const createdJiras = [];

    // ── Expand: Jira assignee is a single picker, so N assignees → N cards ──
    const expandedTickets = [];
    for (const ticket of tickets) {
      let ids = [...triggerMentions];
      if (ids.length === 0 && ticket.assignee_names.length > 0) {
        for (const name of ticket.assignee_names) {
          const id = await findSlackUserByName(client, name);
          if (id) ids.push(id);
        }
      }
      ids = [...new Set(ids)]; // dedupe
      if (ids.length <= 1) {
        expandedTickets.push({ ...ticket, _assigneeIds: ids });
      } else {
        logger.info(`[QABot] ${ids.length} assignees → creating ${ids.length} cards (one per assignee)`);
        for (const id of ids) expandedTickets.push({ ...ticket, _assigneeIds: [id] });
      }
    }

    // Priority precedence: an explicit priority in the request, then (in
    // report threads) the priority the analysis already told the team,
    // then the parser's own rubric-based pick.
    const explicitPrio = lib.explicitPriority(event.text);
    const threadPrio   = (!explicitPrio && (inReportChannel || inProdAudit))
      ? await clientReport.priorityForThread(client, event.channel, threadTs) : null;
    for (const t of expandedTickets) {
      const chosen = explicitPrio || threadPrio;
      if (chosen && chosen !== t.priority) {
        logger.info(`[QABot] Priority ${t.priority || '-'} → ${chosen} (${explicitPrio ? 'requested' : 'from the analysis'})`);
        t.priority = chosen;
      }
    }

    for (const ticket of expandedTickets) {
      const assigneeSlackIds = ticket._assigneeIds;

      // Override platform + summary prefix based on the first assignee's role.
      // Skip for tickets with fixed prefix (e.g. [Client Request] app icon format).
      if (assigneeSlackIds.length > 0 && !ticket.skipPlatformOverride) {
        const inferred = await inferPlatformFromAssignee(client, assigneeSlackIds[0], ticket.platform, `${ticket.summary || ''} ${ticket.description || ''}`);
        if (inferred && inferred !== ticket.platform) {
          logger.info(`[QABot] Platform override: ${ticket.platform} → ${inferred} (assignee role)`);
          ticket.summary  = rewriteSummaryPrefix(ticket.summary, inferred);
          ticket.platform = inferred;
        }
      }

      // ── Parent lookup: sprint-based (live Jira) takes priority over canvas ──
      // Canvas content can be stale when epics are created mid-sprint and not
      // yet added to the canvas. Querying the active sprint directly is reliable.
      // Parent resolution is a NICE-TO-HAVE: it must never delay the ticket.
      // (Sprint JQL search + canvas fallback used to run unbounded — this is
      // the 'created the ticket but stuck adding parent' phase.)
      const tParent = Date.now();
      let parentKey = null;

      // Report channels: cards go under the platform's Client Report epic
      // (iOS → Client Report (iOS), etc.) unless the request names an epic
      // or parent. The sprint-epic search below is for other channels only.
      if (!epicKey && projectRoute?.challenger) {
        parentKey = await lib.challengerEpicFor(ticket.platform);
        logger.info(`[QABot] Challenger epic for ${ticket.platform}: ${parentKey || 'none'}`);
      } else if (inProdAudit && !epicKey && !projectRoute) {
        parentKey = chProfile.epic;
        logger.info(`[QABot] Production Audit epic: ${parentKey}`);
      } else if (inReportChannel && !epicKey && projectRoute) {
        parentKey = projectRoute.parent;
        logger.info(`[QABot] ${targetProject} Client Report epic: ${parentKey}`);
      } else if (inReportChannel && !epicKey) {
        parentKey = clientReport.PLATFORM_PARENTS[ticket.platform] || null;
        if (parentKey) logger.info(`[QABot] Client Report epic for ${ticket.platform}: ${parentKey}`);
        else logger.warn(`[QABot] No Client Report epic mapped for platform "${ticket.platform}"`);
      }
      try {
        if (!parentKey && !projectRoute?.challenger && !epicNamed) parentKey = await Promise.race([
          (async () => {
            const channelInfo = await client.conversations.info({ channel: event.channel });
            const channelName = channelInfo.channel?.name || '';
            const found = await findSprintParent(sprintId, ticket.platform, channelName, ticket.summary || '', ticket.description || '', issueType);
            if (found) logger.info(`[QABot] Parent from active sprint: ${found} (channel: ${channelName})`);
            return found;
          })(),
          new Promise(resolve => setTimeout(() => resolve(null), 20000)),
        ]);
      } catch (e) {
        console.warn('[QABot] Sprint parent lookup failed:', e.message);
      }
      logger.info(`[QABot] Parent resolution: ${parentKey || 'none'} in ${((Date.now() - tParent) / 1000).toFixed(1)}s`);
      // Fall back to canvas-based lookup if sprint search found nothing
      if (!parentKey && !projectRoute?.challenger && !epicNamed && Date.now() - tParent < 20000) {
        parentKey = await pickParentFromCanvas(client, event.channel, ticket.platform);
        logger.info(`[QABot] Parent from canvas: ${parentKey || 'none'} for platform=${ticket.platform}`);
      }

      const jiraIds = (
        await Promise.all(assigneeSlackIds.map(id => resolveJiraAccountId(client, id)))
      ).filter(Boolean);

      // Prepend Slack thread URL to description
      // Inject Slack thread URL into ## Reference section (or prepend if not found)
      // Also strip any LLM-generated N/A lines from Reference
      ticket.description = ticket.description
        .replace(/^-\s*N\/A\s*$/gim, '')          // remove bare "- N/A" lines anywhere
        .replace(/\n{3,}/g, '\n\n')               // collapse 3+ blank lines → 2
        .trim();
      if (ticket.description.includes('## Reference')) {
        // Match both '## Reference' and '## References' (with or without trailing s)
        ticket.description = ticket.description.replace(
          /## References?(?:\n+|$)/,
          `## Reference\n- Slack thread: ${slackThreadUrl}\n`,
        );
      } else {
        ticket.description = `${ticket.description}\n\n## Reference\n- Slack thread: ${slackThreadUrl}`;
      }

      // Client-report channels: enforce the [Client Report]/[Client Request]
      // title convention (bug vs task) before creating.
      if (projectRoute?.challenger) {
        ticket.summary = lib.challengerSummary(ticket.summary, ticket.platform);
      }
      if (inReportChannel) {
        ticket.summary = lib.clientReportSummary(ticket.summary, issueType);
      } else if (inProdAudit) {
        ticket.summary = lib.productionAuditSummary(ticket.summary, chProfile.prefix);
      }
      logger.info(`[QABot] Creating ${issueType}: ${ticket.summary} epic=${epicKey || 'none'} parent=${parentKey || 'none'}`);
      await agentSt.update('📝 _QA Agent is creating the Jira ticket(s)…_');
      const jira = await createJiraIssue(ticket, jiraIds, epicKey, ticketFixVersionId, parentKey, reporterJiraId, issueType, targetProject, createdJiras.map(c => c.jira.key));
      if (epicKey && !jira.applied?.epic) jira.notes = [...(jira.notes || []), `Jira wouldn't attach it to ${epicKey} — pick an epic below`];
      if (epicRejected) jira.notes = [...(jira.notes || []), epicRejected.type
        ? `${epicRejected.key} is a ${epicRejected.type}, not an epic, so it can't be a parent${epicRejected.epicOfIt ? ` — its epic is ${epicRejected.epicOfIt.key} ${epicRejected.epicOfIt.title}, listed first below` : ''}`
        : `I couldn't find ${epicRejected.key} — pick an epic below`];
      if (!epicKey && !jira.applied?.epic) jira.notes = [...(jira.notes || []), 'no epic set'];
      if (skippedAtts.length) jira.notes = [...(jira.notes || []), `${skippedAtts.length} file(s) too large to attach (${skippedAtts.map(s => s.name).join(', ')})`];

      // Post-create steps are BEST EFFORT: a slow/failed sprint, AC or
      // attachment step must never block the ticket confirmation.
      const withBudget = async (label, ms, fn, fallback) => {
        const t = Date.now();
        try {
          const out = await Promise.race([
            fn(),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms)),
          ]);
          logger.info(`[QABot] ${label} ok in ${((Date.now() - t) / 1000).toFixed(1)}s`);
          return out;
        } catch (err) {
          logger.warn(`[QABot] ${label} skipped: ${err.message}`);
          return fallback;
        }
      };

      // Low/Lowest priority UP cards are parked for review: the review
      // sprint instead of the active sprint, then the Need Review status.
      // Low/Lowest priority cards on a board with a review rule (UP → 5097,
      // CHAL → 5098) are parked: the review sprint, then Need Review.
      const lowRule = lib.lowPriorityRule(targetProject, ticket.priority);
      let cardSprintId = targetSprint?.id || null;
      let cardSprintName = targetSprint?.name || null, statusSet = null;
      if (lowRule) {
        const info = await lib.getSprintInfo(lowRule.sprint);
        if (info && info.state !== 'closed') {
          cardSprintId = lowRule.sprint;
          cardSprintName = info.name;
        } else {
          jira.notes = [...(jira.notes || []), `review sprint ${lowRule.sprint} is ${info ? 'closed' : 'unavailable'}${cardSprintId ? ' — used the active sprint' : ' — no sprint set'}`];
        }
      }
      // #production-issues: every UP card goes to that channel's sprint,
      // whatever its priority (Low/Lowest still also get Need Review).
      if (inProdAudit && chProfile.sprint && targetProject === JIRA_PROJECT) {
        const info = await lib.getSprintInfo(chProfile.sprint);
        if (info && info.state !== 'closed') {
          cardSprintId = chProfile.sprint;
          cardSprintName = info.name;
        } else {
          jira.notes = [...(jira.notes || []), `sprint ${chProfile.sprint} is ${info ? 'closed' : 'unavailable'} — used the active sprint`];
        }
      }
      const sprintAdded = cardSprintId
        ? await withBudget('sprint add', 20000, () => addIssueToSprint(jira.key, cardSprintId), false)
        : false;
      if (lowRule) {
        const moved = await withBudget('status → ' + lowRule.status, 20000,
          () => lib.transitionToStatus(jira.key, lowRule.status), { ok: false, reason: 'timed out' });
        if (moved.ok) statusSet = moved.status;
        else jira.notes = [...(jira.notes || []), `couldn't set status ${lowRule.status} (${moved.reason})`];
      }

      // ── Feature 3: Add acceptance criteria checklist ──
      let acCount = 0;
      if (ticket.acceptance_criteria.length > 0) {
        acCount = await withBudget('acceptance criteria', 25000,
          () => addAcceptanceCriteria(jira.key, ticket.acceptance_criteria), 0);
      }

      // Upload attachments
      let uploaded = 0;
      for (const att of attachments) {
        try {
          const buf = att.buffer;
          if (!buf) continue;
          logger.info(`[QABot] Uploading ${att.name} to ${jira.key}...`);
          const ok  = await withBudget(`upload ${att.name}`, 30000,
            () => uploadAttachmentToJira(jira.key, att.name, buf, att.mimetype), false);
          if (ok) { uploaded++; logger.info(`[QABot] ✓ ${att.name}`); }
          else     { logger.warn(`[QABot] ✗ ${att.name} failed to upload`); }
        } catch (err) {
          logger.warn(`[QABot] ✗ ${att.name}: ${err.message}`);
        }
      }
      logger.info(`[QABot] Uploaded ${uploaded}/${attachments.length} attachments to ${jira.key}`);

      // Register follow-up tracking for tickets created in the
      // client-report channels (assignee nudges, QA Ready → SM,
      // QA Success → PC) — same as the module's own creates did.
      if (clientReport.MONITORED_CHANNELS[event.channel]) {
        clientReport.registerFollowUp({
          channelId: event.channel, threadTs, jiraKey: jira.key, jiraUrl: jira.url,
          squad: null, assigneeSlackHint: assigneeSlackIds[0] || null,
        });
      }

      createdJiras.push({ jira, ticket, assigneeSlackIds, uploaded, acCount, sprintAdded, sprintNameOverride: sprintAdded ? cardSprintName : null, statusSet });
    }

    // ── Build Slack response ──────────────────
    const headline = isTask ? `📋 Done — I've created a ${issueType || 'Task'}` : "🐛 Done — I've logged this bug";
    // Release attachment buffers as soon as uploads are done
    for (const att of attachments) att.buffer = null;

    // Resolve the NAMES of what was applied, so the reply says which epic,
    // Fix Version and sprint — not just that "something" was set.
    for (const cj of createdJiras) {
      const a = cj.jira.applied || {};
      cj.facts = {
        epicKey:     a.epic || null,
        epicName:    a.epic ? await lib.getIssueTitle(a.epic) : null,
        versionName: a.fixVersionId ? await lib.getVersionName(a.fixVersionId) : null,
        sprintName:  cj.sprintAdded ? (cj.sprintNameOverride || lib.getLastActiveSprint()?.name || 'Active Sprint') : null,
        statusSet:   cj.statusSet || null,
        project:     cj.jira.key.split('-')[0],
      };
    }

    // The tickets EXIST at this point — a formatting error must never
    // swallow the confirmation. Fall back to a minimal reply on throw.
    let lines;
    try {
    lines = createdJiras.map(({ jira, ticket, assigneeSlackIds, uploaded, acCount, sprintAdded, facts }) => {
      const assigneeLine = assigneeSlackIds.length > 0
        ? `assigned to ${assigneeSlackIds.map(id => `<@${id}>`).join(', ')}`
        : "_I couldn't match an assignee — please assign in Jira_";
      const attachLine = uploaded > 0 ? ` · 📎 ${uploaded}` : '';
      const acLine     = acCount > 0 ? ` · ✅ ${acCount} AC` : '';
      return (
        `${headline} → <${jira.url}|${jira.key}>\n` +
        `*${ticket.summary}*\n` +
        `*${ticket.priority}* priority · *${ticket.platform}* · ${assigneeLine}${attachLine}${acLine}\n` +
        // Report ONLY what was actually applied — never a hardcoded claim —
        // by NAME: the epic as a link titled with its name, plus the exact
        // Fix Version and sprint.
        (() => {
          const f = facts || {};
          const out = [];
          out.push(f.epicKey
            ? `*Epic:* <${JIRA_HOST}/browse/${f.epicKey}|${(f.epicName || f.epicKey).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}>`
            : `*Epic:* none yet — pick one below`);
          out.push(`*Fix Version:* ${f.versionName || (jira.applied?.fixVersion ? 'set' : 'none')}`);
          out.push(f.sprintName
            ? `*Sprint:* ${f.sprintName}`
            : `*Sprint:* not added (no active ${f.project || ''} sprint found)`);
          if (f.statusSet) out.push(`*Status:* ${f.statusSet} (low priority — parked for review)`);
          const problems = (jira.notes || []).filter(n => n !== 'no epic set');
          if (problems.length) out.push(`_${problems.join(' · ')}_`);
          return out.join('\n');
        })()
      );
    });
    } catch (fmtErr) {
      logger.warn('[QABot] Reply formatting failed, using minimal confirmation:', fmtErr.message);
      lines = createdJiras.map(({ jira, ticket }) =>
        `✅ <${jira.url}|${jira.key}> — ${ticket.summary}`);
    }

    const epicLine = '';   // epic is reported per card, by name

    let responseText = lines.join('\n\n') + epicLine;
    await agentSt.done();

    // One "Follow up" button per created ticket — starts (or confirms) the
    // follow-up tracking flow instead of asking people to tag me.
    // In the report channels every card is tracked automatically, so no
    // button — just say so. Elsewhere, offer the Follow up button.
    const autoTracked = !!clientReport.MONITORED_CHANNELS[event.channel];
    const followButtons = autoTracked ? [] : createdJiras.slice(0, 25).map(({ jira, assigneeSlackIds }) => ({
      type: 'button',
      action_id: `qa_followup_start_${jira.key}`,
      text: { type: 'plain_text', text: createdJiras.length > 1 ? `Follow up ${jira.key}` : 'Follow up', emoji: true },
      value: JSON.stringify({ k: jira.key, c: event.channel, t: threadTs, a: assigneeSlackIds?.[0] || null }),
    }));
    if (autoTracked && responseText) {
      const who = [...new Set(createdJiras.flatMap(j => j.assigneeSlackIds || []))].map(id => `<@${id}>`).join(', ');
      responseText += `\n_I'll follow up${who ? ` with ${who}` : ''} until ${createdJiras.length > 1 ? 'they are' : "it's"} closed._`;
    }
    const replyBlocks = responseText ? [
      { type: 'section', text: { type: 'mrkdwn', text: responseText.substring(0, 2900) } },
      ...(followButtons.length ? [{ type: 'actions', elements: followButtons }] : []),
    ] : undefined;

    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text: responseText || "Something went wrong on my side — I wasn't able to create the ticket this time. Try tagging me again in a moment.",
      ...(replyBlocks ? { blocks: replyBlocks } : {}),
    });

    // No epic found → ask whoever triggered the creation to pick one: ONE
    // picker per project for all epic-less cards of this request, with the
    // epics most related to the cards listed first.
    const epicLess = createdJiras.filter(({ jira }) => !jira.applied?.epic);
    const byProject = new Map();
    for (const cj of epicLess) {
      const p = cj.jira.key.split('-')[0];
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p).push(cj);
    }
    for (const [projectKey, group] of byProject) {
      try {
        let epics = projectKey === lib.CHALLENGER_PROJECT
          ? await lib.listOpenEpics('UP', 100, 'Challenger')          // CHAL's epics live in UP
          : await lib.listOpenEpics(projectKey);
        if (!epics.length) continue;
        const cardTitles = epicRelevanceTokens(group.map(g => g.ticket.summary || '').join(' '));
        const rel = (e) => [...epicRelevanceTokens(e.summary)].filter(w => cardTitles.has(w)).length;
        epics = [...epics].map((e, i) => ({ e, i, r: rel(e) }))
          .sort((a, b) => b.r - a.r || a.i - b.i).map(x => x.e);          // related first, then most recent
        const preferred = epicRejected?.epicOfIt;
        if (preferred && preferred.key.startsWith(projectKey === lib.CHALLENGER_PROJECT ? 'UP' : projectKey)) {
          epics = [{ key: preferred.key, summary: preferred.title }, ...epics.filter(e => e.key !== preferred.key)];
        }
        const options = epics.slice(0, 100).map(e => ({
          text:  { type: 'plain_text', text: `${e.key} — ${e.summary}`.substring(0, 75) },
          value: e.key,
        }));
        const keys = group.map(g => g.jira.key);
        const keyList = keys.length === 1
          ? `<${group[0].jira.url}|${keys[0]}>`
          : `${keys.length} cards (${keys.join(', ')})`;
        const who = event.user ? `<@${event.user}>` : 'Someone';
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text: `${who}, I couldn't find the right epic for ${keys.join(', ')} — please select one.`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `${who}, I couldn't find the right epic for ${keyList}. Please select one${keys.length > 1 ? ' — it applies to all of them' : ''}:` } },
            { type: 'actions', block_id: `qa_epic:${keys.join(',')}`.substring(0, 255), elements: [
              { type: 'static_select', action_id: 'qa_epic_pick',
                placeholder: { type: 'plain_text', text: 'Select an epic' }, options },
              { type: 'button', action_id: 'qa_epic_skip', value: keys.join(',').substring(0, 2000),
                text: { type: 'plain_text', text: 'Skip' } },
            ] },
          ],
        });
      } catch (err) {
        logger.warn(`[QABot] Epic prompt for ${projectKey} failed:`, err.data?.error || err.message);
      }
    }

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});

  } catch (err) {
    // Slack missing_scope error — surface exactly which scope is needed
    if (err.code === 'slack_webapi_platform_error' && err.data?.error === 'missing_scope') {
      const needed = err.data?.needed || 'unknown';
      logger.error(`[QABot] Missing Slack scope: ${needed} (provided: ${err.data?.provided})`);
      await agentSt?.done();
      await bootSt?.done();
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts || event.ts,
        text:
          `I couldn't finish — I'm missing the Slack permission \`${needed}\`. ` +
          `An admin can add it at *api.slack.com/apps → OAuth & Permissions → Bot Token Scopes* and reinstall me, then I'll be able to do this.`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
      return;
    }

    const jiraErrors = err.response?.data?.errors;
    const jiraMessages = err.response?.data?.errorMessages;
    const errDetail = jiraErrors
      ? Object.entries(jiraErrors).map(([f, m]) => `${f}: ${m}`).join(', ')
      : (jiraMessages || []).join(', ') || err.message;
    logger.error('[QABot]', err.response?.data ?? err.message);
    await agentSt?.done();
    await bootSt?.done();
      await client.chat.postMessage({
      channel: event.channel, thread_ts: event.thread_ts || event.ts,
      text: `I hit an error while working on this and couldn't finish: \`${errDetail}\`\nGive it another try in a moment — if it keeps failing, my logs have the details.`,
    });
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
  }
};
// Every status message the handler opens is closed when it finishes —
// whichever path it took (replied, returned early, or threw). Previously
// only some paths cleaned up, so a reply could leave "I'm on it" behind.
const coreMentionHandler = async (args) => {
  const _cleanups = [];
  try {
    return await coreMentionHandlerInner({ ...args, _cleanups });
  } finally {
    for (const c of _cleanups) { try { await c(); } catch (_) {} }
  }
};

// Watchdog: a mention must ALWAYS produce a reply. If the handler hasn't
// finished within the budget, post a failure notice and clear the status —
// no more silent 'stuck with an hourglass' requests.
const REQUEST_BUDGET_MS = parseInt(process.env.REQUEST_BUDGET_MS || '120000', 10);

slackApp.event('app_mention', async (args) => {
  const { event, client, logger } = args;
  let finished = false;
  const watchdog = setTimeout(async () => {
    if (finished) return;
    logger.warn(`[QAAgent] WATCHDOG fired after ${REQUEST_BUDGET_MS / 1000}s — request did not complete`);
    try {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts || event.ts, unfurl_links: false,
        text: `I couldn't finish this within ${Math.round(REQUEST_BUDGET_MS / 1000)}s and stopped so I don't leave you hanging. Nothing was created. Please try again — if it keeps happening, my Railway logs show which step stalled.`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'warning', timestamp: event.ts }).catch(() => {});
    } catch (_) {}
  }, REQUEST_BUDGET_MS);

  try {
    await coreMentionHandler(args);
  } catch (err) {
    recordError('mention-handler', err);
    logger.error('[QAAgent] Handler threw:', err?.stack || err);
    try {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts || event.ts, unfurl_links: false,
        text: `I hit an unexpected error and stopped: \`${(err?.message || 'unknown').substring(0, 200)}\`\nNothing may have been created — please retry.`,
      });
    } catch (_) {}
  } finally {
    finished = true;
    clearTimeout(watchdog);
  }
});

// ── Core duplicate-guard button actions ──────────────────────────────
function coreDupPayload(body) {
  try { return JSON.parse(body.actions[0].value); } catch { return null; }
}
async function coreMarkChoice(client, body, line) {
  try {
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: line, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: line } }],
    });
  } catch (_) {}
}
async function coreRunSynthetic(client, logger, payload, text, clickerId) {
  const syntheticEvent = { channel: payload.c, thread_ts: payload.t, ts: payload.t, user: clickerId, text };
  await coreMentionHandler({ event: syntheticEvent, client, logger });
}

slackApp.action('qa_core_dup_force', async ({ ack, body, client, logger }) => {
  await ack();
  const p = coreDupPayload(body); if (!p) return;
  await coreMarkChoice(client, body, `🆕 <@${body.user.id}> chose *log a new ticket anyway* — on it.`);
  await coreRunSynthetic(client, logger, p, `force log ${p.x}`, body.user.id);
});

slackApp.action('qa_core_dup_remaining', async ({ ack, body, client, logger }) => {
  await ack();
  const p = coreDupPayload(body); if (!p) return;
  await coreMarkChoice(client, body, `🧩 <@${body.user.id}> chose *cover remaining issues* — checking what's already ticketed.`);
  const covered = [];
  try {
    const keys = await scanThreadTicketKeys(client, p.c, p.t);
    for (const key of keys.slice(0, 8)) {
      const snap = await getIssueSnapshot(key);
      if (snap) covered.push(`${key} — ${snap.summary}`);
    }
  } catch (_) {}
  const directive =
    `force log ${p.x}\n` +
    `IMPORTANT: Create tickets ONLY for issues discussed in this thread that are NOT already covered by an existing ticket. ` +
    `Already covered (do NOT recreate these): ${covered.length ? covered.join(' | ') : 'unknown — compare against ticket titles found in the thread'}. ` +
    `If every issue is already covered, return an empty tickets array.`;
  await coreRunSynthetic(client, logger, p, directive, body.user.id);
});

slackApp.action('qa_core_dup_follow', async ({ ack, body, client, logger }) => {
  await ack();
  const p = coreDupPayload(body); if (!p) return;
  const lines = [];
  try {
    const keys = await scanThreadTicketKeys(client, p.c, p.t);
    for (const key of keys.slice(0, 8)) {
      const snap = await getIssueSnapshot(key);
      if (!snap) continue;
      const done = ['qa success', 'done', 'released', 'closed'].includes(snap.status.toLowerCase());
      lines.push(`${done ? '✅' : '🔎'} <${JIRA_HOST}/browse/${key}|${key}> — *${snap.status}*${snap.assignee ? ` · ${snap.assignee}` : ''}`);
      if (!done) clientReport.registerFollowUp({ channelId: p.c, threadTs: p.t, jiraKey: key, jiraUrl: `${JIRA_HOST}/browse/${key}`, squad: null });
    }
  } catch (_) {}
  await coreMarkChoice(client, body,
    lines.length
      ? `🔍 <@${body.user.id}> chose *follow up on existing*:\n${lines.join('\n')}\n_I'm tracking the open ones — I'll follow up every 2 business days until closed._`
      : `🔍 I couldn't find live tickets in this thread anymore.`);
});

// ── Bulk create: confirm / cancel ─────────────────────────────────────
const BULK_CREATE_JOBS = new Map();   // id → { channel, tsList, by, threadTs }

slackApp.action('qa_bulk_create_cancel', async ({ ack, body, client }) => {
  await ack();
  BULK_CREATE_JOBS.delete(body.actions?.[0]?.value);
  try {
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: 'Cancelled — no tickets created.',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Cancelled by <@${body.user.id}> — no tickets created.` } }] });
  } catch (_) {}
});

slackApp.action('qa_bulk_create_go', async ({ ack, body, client, logger }) => {
  await ack();
  const id = body.actions?.[0]?.value;
  const job = BULK_CREATE_JOBS.get(id);
  BULK_CREATE_JOBS.delete(id);                       // one run per confirmation
  const channel = body.channel.id, msgTs = body.message.ts, clicker = body.user.id;
  const admins = new Set((process.env.BULK_ADMINS || 'U0142GU335F').split(',').map(s => s.trim()));
  const show = (text) => client.chat.update({ channel, ts: msgTs, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }).catch(() => {});
  if (!job) { await show('This confirmation expired (the bot restarted). Run the command again — it only picks up posts that still have no ticket.'); return; }
  if (!admins.has(clicker)) { BULK_CREATE_JOBS.set(id, job); return; }

  const total = job.tsList.length;
  let done = 0, failed = 0;
  await show(`Creating tickets… 0/${total}`);
  for (const ts of job.tsList) {
    try {
      // Same pipeline as typing "create ticket" in that thread: the card is
      // built from the thread and the confirmation is posted under it.
      await coreMentionHandler({
        event: { channel, thread_ts: ts, ts, user: clicker, text: 'create ticket' },
        client, logger,
      });
      done++;
    } catch (err) {
      failed++;
      logger.warn(`[QAAgent] Bulk create failed for thread ${ts}:`, err?.message || err);
    }
    if ((done + failed) % 5 === 0 || done + failed === total) await show(`Creating tickets… ${done + failed}/${total}`);
    await new Promise(r => setTimeout(r, 4000));      // pace AI + Jira calls
  }
  await show(`Done — processed *${total}* thread(s): ${done} ticket(s) created${failed ? `, ${failed} failed (check those threads)` : ''}. Each card is confirmed in its own thread.`);
});

// ── "Select an epic" prompt for cards created without one ─────────────
slackApp.action('qa_epic_pick', async ({ ack, body, client, logger }) => {
  await ack();
  const action  = body.actions?.[0] || {};
  const cardKeys = (action.block_id || '').replace(/^qa_epic:/, '').split(',').filter(Boolean);
  const epicKey = action.selected_option?.value;
  const epicTxt = action.selected_option?.text?.text || epicKey;
  const clicker = body.user?.id;
  if (!cardKeys.length || !epicKey) return;
  const ok = [], bad = [];
  for (const k of cardKeys) {
    try { await lib.setIssueParent(k, epicKey); ok.push(k); }
    catch (err) { bad.push(k); logger.warn(`[QABot] Epic pick failed for ${k}:`, err.response?.data || err.message); }
  }
  logger.info(`[QABot] ${ok.join(', ')} → epic ${epicKey} (picked by ${clicker})`);
  const link = (k) => `<${JIRA_HOST}/browse/${k}|${k}>`;
  let line = ok.length ? `Added ${ok.map(link).join(', ')} to *${epicTxt}* · by <@${clicker}>` : '';
  if (bad.length) line += `${line ? '\n' : ''}I couldn't add ${bad.join(', ')} to ${epicKey} — please link ${bad.length > 1 ? 'them' : 'it'} in Jira.`;
  try {
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts, text: line,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: line } }],
    });
  } catch (_) {}
});

slackApp.action('qa_epic_skip', async ({ ack, body, client }) => {
  await ack();
  const keys = (body.actions?.[0]?.value || '').split(',').filter(Boolean);
  const line = `No epic set for ${keys.map(k => `<${JIRA_HOST}/browse/${k}|${k}>`).join(', ')} · skipped by <@${body.user?.id}>`;
  try {
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts, text: line,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: line } }],
    });
  } catch (_) {}
});

// ── Follow up button on the ticket confirmation ──────────────────────
slackApp.action(/^qa_followup_start_/, async ({ ack, body, client, logger }) => {
  await ack();
  let p = {};
  try { p = JSON.parse(body.actions[0].value || '{}'); } catch (_) {}
  if (!p.k || !p.c || !p.t) return;
  const clicker = body.user?.id;
  const url = `${JIRA_HOST}/browse/${p.k}`;

  const snap = await lib.getIssueSnapshot(p.k);
  const status = (snap?.status || 'Unknown');
  const statusLc = status.toLowerCase();
  const alreadyTracked = clientReport.isTracked(p.k);

  if (!alreadyTracked && !['qa success', 'done', 'released', 'closed'].includes(statusLc)) {
    clientReport.registerFollowUp({
      channelId: p.c, threadTs: p.t, jiraKey: p.k, jiraUrl: url, squad: null,
      assigneeSlackHint: p.a || null,
      seedStatus: statusLc,
      alreadyAnnounced: ['qa ready'].includes(statusLc),
    });
  }
  if (p.a) clientReport.setTrackedAssignee(p.k, p.a);

  // Replace this ticket's button so it can't be clicked twice
  try {
    const blocks = (body.message?.blocks || []).map(b => {
      if (b.type !== 'actions') return b;
      const remaining = (b.elements || []).filter(el => el.action_id !== body.actions[0].action_id);
      return remaining.length ? { ...b, elements: remaining } : null;
    }).filter(Boolean);
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Follow-up on ${p.k} started by <@${clicker}>` }] });
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: body.message.text || p.k, blocks });
  } catch (err) { logger.warn('[QAAgent] Could not update ticket message:', err.data?.error || err.message); }

  const who = p.a ? `<@${p.a}>` : (snap?.assignee ? `*${snap.assignee}*` : 'the assignee');
  const done = ['qa success', 'done', 'released', 'closed'].includes(statusLc);
  await client.chat.postMessage({
    channel: p.c, thread_ts: p.t, unfurl_links: false,
    text: done
      ? `<${url}|${p.k}> is already *${status}* — nothing to follow up.`
      : `${alreadyTracked ? 'Already tracking' : 'Tracking'} <${url}|${p.k}> (*${status}*). I'll nudge ${who} every 2 business days (Mon–Fri, working hours), tag SM at QA Ready and PC at QA Success.`,
  });
});

// ── The report thread was deleted → remove my messages from it ────────
// Slack reports a deleted thread-starting message in one of two ways:
//   • it had replies  → message_changed, the message becomes a 'tombstone'
//                       ("This message was deleted.")
//   • no replies      → message_deleted (nothing of mine to clean)
// Deleted REPLIES (including my own clean-up deletions) are ignored.
function deletedThreadTs(event) {
  if (event.subtype === 'message_changed' && event.message?.subtype === 'tombstone') {
    return event.message.ts;
  }
  if (event.subtype === 'message_deleted') {
    const prev = event.previous_message || {};
    const isParent = !prev.thread_ts || prev.thread_ts === prev.ts;
    if (isParent && (prev.reply_count > 0 || prev.thread_ts)) return event.deleted_ts || prev.ts;
  }
  return null;
}

slackApp.event('message', async ({ event, client, logger }) => {
  const threadTs = deletedThreadTs(event);
  if (!threadTs) return;
  try {
    const removed = await lib.retractOwnMessages(client, event.channel, threadTs, 'all');
    const stopped = clientReport.stopTrackingThread(event.channel, threadTs);
    if (removed || stopped.length) {
      logger.info(`[QAAgent] Thread ${threadTs} deleted in ${event.channel} — removed ${removed} of my message(s)${stopped.length ? `, stopped follow-up on ${stopped.join(', ')}` : ''}`);
    }
  } catch (err) {
    // thread_not_found etc. — the thread is already gone, nothing to clean
    if (!/thread_not_found|message_not_found/.test(err.data?.error || '')) {
      logger.warn('[QAAgent] Deleted-thread clean-up failed:', err.data?.error || err.message);
    }
  }
});

// ── Assign button on the analysis → member picker → create + assign ──
slackApp.action('qa_assign_open', async ({ ack, body, client, logger }) => {
  await ack();
  let p = {};
  try { p = JSON.parse(body.actions[0].value || '{}'); } catch (_) {}
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'qa_assign_submit',
        private_metadata: JSON.stringify({ c: p.c, t: p.t, m: body.message?.ts || null }),
        title:  { type: 'plain_text', text: 'Assign' },
        submit: { type: 'plain_text', text: 'Create & assign' },
        close:  { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input', block_id: 'assignee_block',
            label: { type: 'plain_text', text: 'Assign to' },
            element: {
              type: 'multi_users_select', action_id: 'assignees', max_selected_items: 5,
              placeholder: { type: 'plain_text', text: 'Pick one or more members' },
            },
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: "I'll create the Jira card from this thread. Pick several people and each gets their own card — Jira allows one assignee per card, and each card follows that person's platform (e.g. iOS, BE)." }],
          },
        ],
      },
    });
  } catch (err) {
    logger.warn('[QAAgent] Could not open assign modal:', err.data?.error || err.message);
  }
});

slackApp.view('qa_assign_submit', async ({ ack, body, view, client, logger }) => {
  await ack();   // close the modal immediately; the work continues in the thread
  let meta = {};
  try { meta = JSON.parse(view.private_metadata || '{}'); } catch (_) {}
  const blockVals = view.state?.values?.assignee_block || {};
  const assignees = [...new Set(
    blockVals.assignees?.selected_users ||                       // multi-select
    (blockVals.assignee?.selected_user ? [blockVals.assignee.selected_user] : [])   // older single-select modals
  )];
  const clicker  = body.user?.id;
  if (!meta.c || !meta.t || !assignees.length) return;
  const who = assignees.map(id => `<@${id}>`).join(', ');

  // Visible audit line in the thread — also the anchor for status/reactions
  let anchorTs = meta.t;
  try {
    const posted = await client.chat.postMessage({
      channel: meta.c, thread_ts: meta.t, unfurl_links: false,
      text: assignees.length > 1
        ? `<@${clicker}> asked me to create a Jira card for each of ${who}.`
        : `<@${clicker}> asked me to create a Jira card and assign it to ${who}.`,
    });
    anchorTs = posted.ts;
  } catch (_) {}

  // Replace the Assign button so it can't be clicked twice
  if (meta.m) {
    try {
      const rr = await client.conversations.replies({ channel: meta.c, ts: meta.t, limit: 100 });
      const msg = (rr.messages || []).find(x => x.ts === meta.m);
      if (msg) {
        const blocks = (msg.blocks || []).filter(b => b.type !== 'actions');
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Assigned to ${who} by <@${clicker}>` }] });
        await client.chat.update({ channel: meta.c, ts: meta.m, text: msg.text || 'Analysis', blocks });
      }
    } catch (err) { logger.warn('[QAAgent] Could not update analysis message:', err.data?.error || err.message); }
  }

  // Same pipeline as typing "create ticket and assign to @X" in the thread
  try {
    await coreMentionHandler({
      event: { channel: meta.c, thread_ts: meta.t, ts: anchorTs, user: clicker, text: `create ticket and assign to ${assignees.map(id => `<@${id}>`).join(' ')}` },
      client, logger,
    });
  } catch (err) {
    logger.error('[QAAgent] Assign-modal create failed:', err?.stack || err);
    try {
      await client.chat.postMessage({
        channel: meta.c, thread_ts: meta.t, unfurl_links: false,
        text: `I hit an error creating the card: \`${(err?.message || 'unknown').substring(0, 200)}\` — please retry.`,
      });
    } catch (_) {}
  }
});

slackApp.action('qa_core_dup_cancel', async ({ ack, body, client }) => {
  await ack();
  await coreMarkChoice(client, body, `✖️ <@${body.user.id}> cancelled — nothing created.`);
});

(async () => {
  await slackApp.start(process.env.PORT || 3001);
  console.log('✅ QABot running on port', process.env.PORT || 3001);
  clientReport.register(slackApp, openai);
  release.register(slackApp);
  release.startScheduler(slackApp.client);
})();
