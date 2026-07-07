require('dotenv').config();
const { App } = require('@slack/bolt');
const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

const slackApp = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  const result   = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 200 });
  const messages = result.messages || [];
  const lines    = [];
  for (const msg of messages) {
    // Skip bot messages — bot error/success replies from previous attempts
    // poison the context and cause GPT to return empty results
    if (msg.bot_id || msg.subtype === 'bot_message') continue;
    let name = msg.username || msg.user || 'user';
    try {
      const info = await client.users.info({ user: msg.user });
      name = info.user?.real_name || name;
    } catch (_) {}
    const text = (msg.text || '')
      // User mentions <@USERID> → @name
      .replace(/<@([A-Z0-9]+)>/g, (_, uid) => `@${uid}`)
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
    const res = await openai.chat.completions.create({
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
async function parseBugReport(context) {
  const res = await openai.chat.completions.create({
    model:      'gpt-4o-mini',
    max_tokens: 3000,
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

MULTI-BUG RULES (VERY IMPORTANT — err on the side of ONE ticket):
- DEFAULT: Create exactly ONE ticket per thread. Most bug reports are a single bug.
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
      { role: 'user', content: `QA bug report thread:\n\n${context}` },
    ],
  });

  const raw = res.choices[0].message.content.replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }

  // Normalize to array
  // Treat both null AND empty array as a failed parse — return a fallback ticket
  const ticketsRaw = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  if (ticketsRaw.length === 0) {
    return [{
      summary:             '[iOS Client][Bug] Bug report from QA — please update summary',
      priority:            'Medium',
      platform:            'iOS Client',
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
async function parseTaskReport(context) {
  const res = await openai.chat.completions.create({
    model:      'gpt-4o-mini',
    max_tokens: 3000,
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

MULTI-TASK RULES (VERY IMPORTANT — err on the side of ONE ticket):
- DEFAULT: Return exactly ONE ticket. Almost every task thread is a single task.
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
      { role: 'user', content: `Task request thread:\n\n${context}` },
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
  const res = await openai.chat.completions.create({
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
    `\n\n## References${refs || ''}`;

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

async function createJiraIssue(ticket, jiraAccountIds, epicKey, fixVersionId, parentKey, reporterJiraId, issueType = 'Bug') {
  const fields = {
    project:     { key: JIRA_PROJECT },
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
  const upKeys   = [...new Set((canvasContent.match(/UP-\d+/g)   || []))];
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
    return sprintRes.data?.values?.[0]?.id ?? null;
  } catch { return null; }
}

async function addIssueToSprint(issueKey, sprintId) {
  try {
    await axios.post(`${JIRA_HOST}/rest/agile/1.0/sprint/${sprintId}/issue`,
      { issues: [issueKey] },
      { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
  } catch (_) {}
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
async function inferPlatformFromAssignee(client, slackUserId, fallbackPlatform) {
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
    const tagMatch = bucket ? null : haystack.match(/\((be|fe|backend|frontend|ios|android|web)\)/i);
    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase();
      if      (tag === 'be' || tag === 'backend')                      bucket = 'api';
      else if (tag === 'fe' || tag === 'frontend' || tag === 'web')    bucket = 'web';
      else if (tag === 'ios')                                          bucket = 'ios';
      else if (tag === 'android')                                      bucket = 'android';
    }

    // 2) Fall back to job title keywords (only if no tag was found)
    if (!bucket) {
      if      (/back[\s-]?end|api engineer|server engineer/.test(title)) bucket = 'api';
      else if (/front[\s-]?end|web engineer/.test(title))                bucket = 'web';
      else if (/\bios\b/.test(title))                                    bucket = 'ios';
      else if (/\bandroid\b/.test(title))                                bucket = 'android';
    }

    if (!bucket) return null;

    // If the assignee's bucket matches the LLM-parsed platform, keep the LLM platform —
    // this preserves the Coach vs Client distinction the LLM picked up from the thread.
    const fallbackBucket = getPlatformBucket(fallbackPlatform);
    if (bucket === fallbackBucket) return fallbackPlatform;

    // Mismatch → switch to the assignee's bucket. Default to "Coach" for mobile
    // (most internal threads concern the Coach app; QA can adjust if it's Client).
    if (bucket === 'api')     return 'API';
    if (bucket === 'web')     return 'Web';
    if (bucket === 'ios')     return 'iOS Coach';
    if (bucket === 'android') return 'Android Coach';
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
async function findSprintParent(activeSprintId, platform, channelName) {
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

    const res = await axios.get(`${JIRA_HOST}/rest/api/3/search`, {
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
    const keywords = extractChannelKeywords(channelName);
    let best = null, bestScore = -1;
    for (const issue of issues) {
      const titleWords = issue.fields.summary.toLowerCase().split(/[\s|\-]+/);
      const score = keywords.filter(k => titleWords.some(w => w.includes(k))).length;
      if (score > bestScore) { bestScore = score; best = issue.key; }
    }
    const result = best || issues[0].key;
    console.log(`[QABot] Sprint parent found: ${result} (score=${bestScore}, platform=${platform}, channel=${channelName})`);
    return result;
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

slackApp.event('app_mention', async ({ event, client, logger }) => {
  const authRes   = await client.auth.test();
  const botUserId = authRes.user_id;
  const botBotId  = authRes.bot_id;
  const threadTs  = event.thread_ts || event.ts;

  // Detect "force log" command
  const triggerText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();
  const isForceLog  = triggerText.startsWith('force log') || triggerText.startsWith('force');

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  try {
    // Fetch thread context first — needed for AI classification below
    let context;
    if (event.thread_ts) {
      context = await getThread(client, event.channel, event.thread_ts);
    } else {
      context = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    }

    if (!context || context.trim().length < 10) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: '👋 Tag me *inside a thread* — I\'ll log the bug or task to Jira automatically!\n' +
              'Use `create task` to create a Task, or just tag me to auto-detect.',
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // Classify Bug vs Task — explicit keyword wins; otherwise AI decides from thread content
    const issueType = await classifyIssueType(triggerText, context);
    const isTask    = issueType === 'Task';
    logger.info(`[QABot] Issue type classified as: ${issueType}`);

    // ── Feature 2: Duplicate detection ──────────
    // Scan thread for existing QABot tickets
    const existingKeys = [];
    const existingSummaries = [];
    try {
      const threadResult = await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 50 });
      for (const msg of (threadResult.messages || [])) {
        if (msg.bot_id !== botBotId) continue;
        const keyMatches = (msg.text || '').match(/UP-\d+/g) || [];
        existingKeys.push(...keyMatches);
        const summaryMatch = (msg.text || '').match(/\*(.+?)\*/);
        if (summaryMatch) existingSummaries.push(summaryMatch[1].toLowerCase());
      }
    } catch (_) {}

    // If tickets already exist and NOT force log → notify and ask
    // Skip duplicate detection for explicit Task creation — user is intentionally creating a new ticket
    if (existingKeys.length > 0 && !isForceLog && !isTask) {
      const ticketLinks = [...new Set(existingKeys)].map(k => `<${JIRA_HOST}/browse/${k}|${k}>`).join(', ');
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text:
          `⚠️ This thread already has logged ticket(s): ${ticketLinks}\n` +
          `If you still want to create a new ticket, reply with:\n` +
          `\`@qa-bot force log\``,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'warning', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Feature 1: Parse — returns array of tickets ──
    // App Icon requests get a specialized parser with a fixed description template
    const tickets = isTask && isAppIconRequest(context)
      ? await parseAppIconRequest(context)
      : isTask
        ? await parseTaskReport(context)
        : await parseBugReport(context);
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
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text:
          `⚠️ I couldn't extract a ${issueType.toLowerCase()} from this thread. ` +
          `Please make sure the thread describes the issue or request (not just assign commands), then tag me again.`,
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
    if (ccMatch) {
      logger.info(`[QABot] cc/fyi detected — assignees limited to mentions before "${ccMatch[0]}"`);
    }

    // Parse Epic from trigger message (PLAN-XXX or UP-XXX)
    const epicMatch = event.text.match(/\b(PLAN-\d+|UP-\d+)\b/i);
    const epicKey   = epicMatch ? epicMatch[0].toUpperCase() : null;

    // Hardcoded fix version = "To be confirmed" (ID 12023)
    const fixVersionId = '12023';

    // Resolve reporter: the person who tagged the bot (NOT the thread author)
    const reporterSlackId = event.user;
    const reporterJiraId = await resolveJiraAccountId(client, reporterSlackId);
    logger.info(`[QABot] Reporter/QA set to: ${reporterSlackId} → Jira ${reporterJiraId || 'not found'}`);

    const slackThreadUrl = buildSlackThreadUrl(event.channel, threadTs);
    const attachments    = await getAllThreadAttachments(client, event.channel, threadTs);
    const sprintId       = await getActiveSprintId();
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

    for (const ticket of expandedTickets) {
      const assigneeSlackIds = ticket._assigneeIds;

      // Override platform + summary prefix based on the first assignee's role.
      // Skip for tickets with fixed prefix (e.g. [Client Request] app icon format).
      if (assigneeSlackIds.length > 0 && !ticket.skipPlatformOverride) {
        const inferred = await inferPlatformFromAssignee(client, assigneeSlackIds[0], ticket.platform);
        if (inferred && inferred !== ticket.platform) {
          logger.info(`[QABot] Platform override: ${ticket.platform} → ${inferred} (assignee role)`);
          ticket.summary  = rewriteSummaryPrefix(ticket.summary, inferred);
          ticket.platform = inferred;
        }
      }

      // ── Parent lookup: sprint-based (live Jira) takes priority over canvas ──
      // Canvas content can be stale when epics are created mid-sprint and not
      // yet added to the canvas. Querying the active sprint directly is reliable.
      let parentKey = null;
      try {
        const channelInfo = await client.conversations.info({ channel: event.channel });
        const channelName = channelInfo.channel?.name || '';
        parentKey = await findSprintParent(sprintId, ticket.platform, channelName);
        if (parentKey) {
          logger.info(`[QABot] Parent from active sprint: ${parentKey} (channel: ${channelName})`);
        }
      } catch (e) {
        console.warn('[QABot] Sprint parent lookup failed:', e.message);
      }
      // Fall back to canvas-based lookup if sprint search found nothing
      if (!parentKey) {
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
        ticket.description = ticket.description.replace(
          /## Reference(?:\n+|$)/,
          `## Reference\n- Slack thread: ${slackThreadUrl}\n`,
        );
      } else {
        ticket.description = `${ticket.description}\n\n## Reference\n- Slack thread: ${slackThreadUrl}`;
      }

      logger.info(`[QABot] Creating ${issueType}: ${ticket.summary} epic=${epicKey || 'none'} parent=${parentKey || 'none'}`);
      const jira = await createJiraIssue(ticket, jiraIds, epicKey, fixVersionId, parentKey, reporterJiraId, issueType);

      if (sprintId) await addIssueToSprint(jira.key, sprintId);

      // ── Feature 3: Add acceptance criteria checklist ──
      let acCount = 0;
      if (ticket.acceptance_criteria.length > 0) {
        acCount = await addAcceptanceCriteria(jira.key, ticket.acceptance_criteria);
      }

      // Upload attachments
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

      createdJiras.push({ jira, ticket, assigneeSlackIds, uploaded, acCount });
    }

    // ── Build Slack response ──────────────────
    const headline = isTask ? '📋 *Task created!*' : '🐛 *Bug logged!*';
    const lines = createdJiras.map(({ jira, ticket, assigneeSlackIds, uploaded, acCount }) => {
      const assigneeLine = assigneeSlackIds.length > 0
        ? `Assigned to ${assigneeSlackIds.map(id => `<@${id}>`).join(', ')}`
        : '_No assignee — please assign in Jira_';
      const attachLine = uploaded > 0 ? ` · 📎 ${uploaded}` : '';
      const acLine     = acCount > 0 ? ` · ✅ ${acCount} AC` : '';
      return (
        `${headline} → <${jira.url}|${jira.key}>\n` +
        `*${ticket.summary}*\n` +
        `Priority: *${ticket.priority}* · Platform: *${ticket.platform}*\n` +
        `${assigneeLine}${attachLine}${acLine}`
      );
    });

    const epicLine = epicKey ? `\nEpic: <${JIRA_HOST}/browse/${epicKey}|${epicKey}>` : '';

    const responseText = lines.join('\n\n') + epicLine;
    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text: responseText || '⚠️ No tickets were created — check Railway logs for details.',
    });

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});

  } catch (err) {
    // Slack missing_scope error — surface exactly which scope is needed
    if (err.code === 'slack_webapi_platform_error' && err.data?.error === 'missing_scope') {
      const needed = err.data?.needed || 'unknown';
      logger.error(`[QABot] Missing Slack scope: ${needed} (provided: ${err.data?.provided})`);
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts || event.ts,
        text:
          `❌ QABot error: Missing Slack permission scope \`${needed}\`.
` +
          `Ask an admin to add this scope at *api.slack.com/apps → OAuth & Permissions → Bot Token Scopes*.`,
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
