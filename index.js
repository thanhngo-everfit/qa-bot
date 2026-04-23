require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

// ── Platform → Jira parent ticket ─────────────
const PLATFORM_PARENTS = {
  'iOS Client':     'UP-23735',
  'iOS Coach':      'UP-23735',
  'Android Client': 'UP-23734',
  'Android Coach':  'UP-23734',
  'Web':            'UP-23736',
  'API':            'UP-23733',
};

const slackApp = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

async function getThread(client, channelId, threadTs) {
  const result   = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
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

async function getFirstMessageAttachments(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
    const first  = result.messages?.[0];
    if (!first) return [];
    const files = first.files || [];
    return files
      .filter(f => f.url_private_download)
      .map(f => ({
        name:     f.name || f.title || 'attachment',
        url:      f.url_private_download,
        mimetype: f.mimetype || 'application/octet-stream',
      }));
  } catch (err) {
    console.warn('[QABot] Could not get attachments:', err.message);
    return [];
  }
}

async function downloadSlackFile(url) {
  const res = await axios.get(url, {
    headers:      { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: 'arraybuffer',
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
          Authorization:     jiraAuth(),
          'X-Atlassian-Token': 'no-check',
        },
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
async function parseBugReport(context) {
  const res = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system: `You are QABot for Everfit. Parse a QA bug report from a Slack thread. Return ONLY valid JSON, NO markdown fences, NO explanation.

REQUIRED fields (you MUST fill every one — never return null or empty):
{
  "summary": "Title in EXACT format: [Platform][Feature] Short description. NEVER use [Client Report] prefix. Platform MUST be one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach. Feature = affected feature area. Keep under 80 chars total. Always include a description after the brackets.",
  "priority": "High" or "Medium" or "Low",
  "platform": "one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach",
  "description": "Use this exact format:\\n\\nSteps to reproduce:\\n1. <step>\\n2. <step>\\n\\nExpected behavior:\\n- <expected>\\n\\nActual behavior:\\n- <actual>\\n\\nEnvironment:\\n- <browser/device/OS/app version if mentioned, else N/A>\\n\\nNote: <useful context or N/A>",
  "assignee_names": ["Full Name of assignee — look for '@X check', 'nhờ @X', '@X fix'. Empty array [] if unclear."]
}

PLATFORM DETECTION:
- Web → dashboard UI issues
- API → backend, data, sync, auth
- iOS Client / iOS Coach → iOS app (client-facing vs coach-facing)
- Android Client / Android Coach → Android app
- When BOTH iOS AND Android are mentioned, pick the first one in the report

PRIORITY: High = crash/data loss/blocking QA. Medium = broken feature. Low = cosmetic/UI glitch.

If the thread is in Vietnamese, return everything in English.
NEVER return null, undefined, or empty strings. Always make a reasonable guess.`,
    messages: [{ role: 'user', content: `QA bug report thread:\n\n${context}` }],
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }

  // Defensive defaults — never undefined
  return {
    summary:        parsed.summary        || `[Web][Bug] ${context.substring(0, 60).replace(/\n/g, ' ')}`,
    priority:       parsed.priority       || 'Medium',
    platform:       parsed.platform       || 'Web',
    description:    parsed.description    || context,
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

function buildAdfDescription(text) {
  const lines = (text || '').split('\n');
  const content = [];
  for (const line of lines) {
    if (line.trim() === '') content.push({ type: 'paragraph', content: [] });
    else content.push({ type: 'paragraph', content: lineToAdfContent(line) });
  }
  return { type: 'doc', version: 1, content };
}

async function createJiraIssue(ticket, jiraAccountIds, epicKey, fixVersionId, parentKey) {
  const fields = {
    project:     { key: JIRA_PROJECT },
    summary:     ticket.summary,
    issuetype:   { name: 'Bug' },
    priority:    { name: ticket.priority },
    description: buildAdfDescription(ticket.description),
  };

  // Parent from channel canvas (if found)
  if (parentKey) fields.parent = { key: parentKey };
  if (epicKey) fields['customfield_10014'] = epicKey;
  if (fixVersionId) fields.fixVersions = [{ id: fixVersionId }];
  if (jiraAccountIds.length > 0) fields.assignee = { accountId: jiraAccountIds[0] };

  const res = await axios.post(`${JIRA_HOST}/rest/api/3/issue`, { fields }, {
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { key: res.data.key, url: `${JIRA_HOST}/browse/${res.data.key}` };
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

    const ticket = await parseBugReport(context);
    logger.info(`[QABot] Parsed: ${ticket.summary} [${ticket.priority}] platform=${ticket.platform}`);

    // Detect assignee
    const triggerMentions = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
      .map(m => m.replace(/<@|>/g, ''))
      .filter(id => id !== botUserId);

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

    // Parse Epic from trigger message (PLAN-XXX or UP-XXX) — ignore if it matches an assignee mention
    const epicMatch = event.text.match(/\b(PLAN-\d+|UP-\d+)\b/i);
    const epicKey   = epicMatch ? epicMatch[0].toUpperCase() : null;

    // Hardcoded fix version = "To be confirmed" (ID 12023)
    const fixVersionId = '12023';

    // Read parent from channel canvas
    const parentKey = await getParentFromChannelCanvas(client, event.channel);
    logger.info(`[QABot] Parent from canvas: ${parentKey || 'none'}`);

    const attachments = await getFirstMessageAttachments(client, event.channel, threadTs);
    logger.info(`[QABot] Creating: epic=${epicKey || 'none'} fixVersion=${fixVersionId || 'none'} parent=${parentKey || 'none'} attachments=${attachments.length}`);

    const jira = await createJiraIssue(ticket, jiraIds, epicKey, fixVersionId, parentKey);

    const sprintId = await getActiveSprintId();
    if (sprintId) await addIssueToSprint(jira.key, sprintId);

    // Upload attachments
    let uploaded = 0;
    for (const att of attachments) {
      try {
        const buf = await downloadSlackFile(att.url);
        const ok  = await uploadAttachmentToJira(jira.key, att.name, buf, att.mimetype);
        if (ok) uploaded++;
      } catch (_) {}
    }

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
    logger.error('[QABot]', err.response?.data ?? err.message);
    await client.chat.postMessage({
      channel: event.channel, thread_ts: event.thread_ts || event.ts,
      text: `❌ QABot error: \`${err.message}\``,
    });
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
  }
});

(async () => {
  await slackApp.start(process.env.PORT || 3001);
  console.log('✅ QABot running on port', process.env.PORT || 3001);
})();
