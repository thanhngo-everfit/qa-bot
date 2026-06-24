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

// ── Detect requested issue type from the trigger text ──
// ── Classify Bug vs Task from thread content ─────────────────────────────
// 1. Explicit keyword in trigger → trust it immediately (no AI call).
// 2. No keyword → ask GPT to decide from the thread so we don't default
//    every bare trigger (e.g. "assign to @X") to Bug.
async function classifyIssueType(triggerText, threadContext) {
  const lower = (triggerText || '').toLowerCase();

  // Explicit task signals (English + Vietnamese)
  if (/\btask\b|tạo task|create task|log task/.test(lower)) return 'Task';

  // Explicit bug signals
  if (/\bbug\b|log bug|create bug|report bug|báo lỗi|tạo bug/.test(lower)) return 'Bug';

  // No explicit keyword — classify from thread content via AI
  try {
    const res = await openai.chat.completions.create({
      model:      'gpt-4o-mini',
      max_tokens: 10,
      messages: [
        {
          role: 'system',
          content:
            'You classify Slack threads as either Bug or Task.\n' +
            'Bug = something broken, not working correctly, wrong behaviour, crash, visual defect.\n' +
            'Task = a work request, improvement, config change, process change, feature, investigation, or action item.\n' +
            'Reply with exactly one word: Bug or Task.',
        },
        { role: 'user', content: threadContext || triggerText },
      ],
    });
    const answer = (res.choices[0].message.content || '').trim();
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
3. Ignore command messages (lines like "@X assign to @Y", "@qa-bot ...", "@bug-reporting-tracker ...").
4. Extract every actual bug: what is broken, on what platform, steps to reproduce.
5. Translate any Vietnamese content to English.
6. The summary should describe the bug clearly — NOT include "[Thanh Ngo]:" or usernames or "Nhờ team check" boilerplate.

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
    "description": "Use this EXACT structure with ## section headings (use real newlines and **bold** for emphasis):\n\n## Bug Description\n[1-2 sentence narrative: what is broken and under what conditions]\n\n## Root Cause\n[Technical explanation of WHY this happens. If not explicitly stated, make a reasonable inference from the thread context.]\n\nImpact:\n- [impact on users or system]\n- [add more if multiple impacts]\n\n## Expected Behavior\n- [what should happen]\n\n## Steps to Reproduce\n1. [clear step]\n2. [clear step]\n3. [clear step]\n\n## Environment\n- [browser, device, OS, app version if mentioned, else N/A]\n\n## Reference\n- [related ticket numbers e.g. PAY-XXXX, UP-XXXX if mentioned, else omit this line]",
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
  if (!parsed) {
    return [{
      summary:             '[Web][Bug] Bug report from QA',
      priority:            'Medium',
      platform:            'Web',
      description:         'Description not parsed. Please update manually.',
      assignee_names:      [],
      acceptance_criteria: [],
    }];
  }

  const tickets = Array.isArray(parsed) ? parsed : [parsed];

  // Defensive defaults for each ticket
  return tickets.map(t => {
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
3. Ignore command messages (lines like "@X assign to @Y", "@qa-bot create task ...").
4. Translate any Vietnamese content to English.
5. The summary should describe the TASK clearly (what to do) — NOT include "[Thanh Ngo]:" or usernames or "Nhờ team check" boilerplate.
6. A task is work to be done (improvement, new feature, configuration, follow-up). It is NOT a bug report.

MULTI-TASK RULES:
- If the thread requests MULTIPLE RELATED items on the SAME feature/screen → merge into ONE ticket.
- If the thread requests UNRELATED items → create SEPARATE tickets.
- Most threads will produce just 1 ticket.

Return ONLY a valid JSON ARRAY (NO markdown fences, NO explanation):

[
  {
    "summary": "[Platform][Feature] Clear task description. Platform MUST be one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach. Feature is the affected screen/module/area (e.g. 2FA, Workout Builder, Onboarding, Billing, Calendar). NEVER use the literal word 'Task' as the second prefix. Under 80 chars total. NEVER include @mentions, subteam IDs, or [Name]: prefixes.",
    "priority": "Highest" or "High" or "Medium" or "Low" or "Lowest",
    "platform": "one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach",
    "description": "Use this EXACT structure with ## section headings (use real newlines and **bold** for emphasis):\n\n## Task Description\n[1-2 sentence description of what needs to be done and why]\n\n## Goal\n[What the completed task should achieve]\n\n## Requirements\n- [requirement 1]\n- [requirement 2]\n\n## Reference\n- [related ticket numbers or context if mentioned, else omit this line]",
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

  if (!parsed) {
    return [{
      summary:             '[Web][General] Task request',
      priority:            'Medium',
      platform:            'Web',
      description:         'Description not parsed. Please update manually.',
      assignee_names:      [],
      acceptance_criteria: [],
    }];
  }

  const tickets = Array.isArray(parsed) ? parsed : [parsed];

  return tickets.map(t => {
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
        attrs: { level: 3 },
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
    const title       = (profile.title || '').toLowerCase();
    const haystack    = `${displayName} ${title}`;

    let bucket = null;

    // 1) Everfit convention: parenthesized role tag in the display name, e.g. "Hong (BE)"
    const tagMatch = haystack.match(/\((be|fe|backend|frontend|ios|android|web)\)/i);
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
    const tickets = isTask
      ? await parseTaskReport(context)
      : await parseBugReport(context);
    logger.info(`[QABot] Parsed ${tickets.length} ${issueType.toLowerCase()}(s)`);

    // Detect assignee from trigger message
    const triggerMentions = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
      .map(m => m.replace(/<@|>/g, ''))
      .filter(id => id !== botUserId);

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

    for (const ticket of tickets) {
      // Resolve assignees FIRST — platform may depend on the assignee's role.
      let assigneeSlackIds = [...triggerMentions];
      if (assigneeSlackIds.length === 0 && ticket.assignee_names.length > 0) {
        for (const name of ticket.assignee_names) {
          const id = await findSlackUserByName(client, name);
          if (id) assigneeSlackIds.push(id);
        }
      }

      // Override platform + summary prefix based on the first assignee's role.
      // Rule (per QA team): [Prefix] follows the platform of the person being assigned,
      // not whatever the thread discussion happened to be about.
      if (assigneeSlackIds.length > 0) {
        const inferred = await inferPlatformFromAssignee(client, assigneeSlackIds[0], ticket.platform);
        if (inferred && inferred !== ticket.platform) {
          logger.info(`[QABot] Platform override: ${ticket.platform} → ${inferred} (assignee role)`);
          ticket.summary  = rewriteSummaryPrefix(ticket.summary, inferred);
          ticket.platform = inferred;
        }
      }

      // Read parent from channel canvas using the FINAL platform (post-override).
      const parentKey = await pickParentFromCanvas(client, event.channel, ticket.platform);
      logger.info(`[QABot] Parent from canvas: ${parentKey || 'none'} for platform=${ticket.platform}`);

      const jiraIds = (
        await Promise.all(assigneeSlackIds.map(id => resolveJiraAccountId(client, id)))
      ).filter(Boolean);

      // Prepend Slack thread URL to description
      // Inject Slack thread URL into ## Reference section (or prepend if not found)
      if (ticket.description.includes('## Reference')) {
        ticket.description = ticket.description.replace(
          /## Reference\n/,
          `## Reference\n- Slack thread: ${slackThreadUrl}\n`,
        );
      } else {
        ticket.description = `## Reference\n- Slack thread: ${slackThreadUrl}\n\n${ticket.description}`;
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

    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text: lines.join('\n\n') + epicLine,
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
