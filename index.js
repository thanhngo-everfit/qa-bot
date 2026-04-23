require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

// ── Pending ticket sessions ────────────────────
// Stores ephemeral state while waiting for Epic/FixVersion input
// { threadTs → { channelId, threadTs, parsedTicket, attachments, step, epicKey, fixVersionId } }
const pendingSession = new Map();

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

// ── Resolve Slack user → Jira account ID ──────
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

// ── Read full thread with real names ──────────
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

// ── Get first message attachments ────────────
async function getFirstMessageAttachments(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
    const first  = result.messages?.[0];
    if (!first) return [];

    const attachments = [];

    // Slack file objects in the message
    const files = first.files || [];
    for (const file of files) {
      if (!file.url_private_download) continue;
      attachments.push({
        name:     file.name || file.title || 'attachment',
        url:      file.url_private_download,
        mimetype: file.mimetype || 'application/octet-stream',
      });
    }
    return attachments;
  } catch (err) {
    console.warn('[QABot] Could not get attachments:', err.message);
    return [];
  }
}

// ── Download file from Slack ──────────────────
async function downloadSlackFile(url) {
  const res = await axios.get(url, {
    headers:      { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: 'arraybuffer',
  });
  return Buffer.from(res.data);
}

// ── Upload attachment to Jira issue ──────────
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

// ── Fetch Jira fix versions ────────────────────
async function getFixVersions() {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/project/${JIRA_PROJECT}/versions`, {
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return (res.data || []).filter(v => !v.archived && !v.released);
  } catch { return []; }
}

// ── Fetch Jira epics for project ──────────────
async function getEpics() {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/issue/picker`, {
      params:  { query: '', currentProjectId: JIRA_PROJECT, showSubTaskParent: false },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return res.data?.sections?.flatMap(s => s.issues || []) || [];
  } catch { return []; }
}

// ── Parse QA bug report with Claude ──────────
async function parseBugReport(context) {
  const res = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system: `You are QABot for Everfit. Parse the QA bug report from a Slack thread and return ONLY valid JSON, no markdown fences.

Schema:
{
  "summary": "Title format: [Platform][Feature] Short description. Platform = one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach. Feature = affected feature e.g. Video Workout, Workout, Calendar, Payment, Login. Keep concise, max 80 chars. NO [Client Report] prefix.",
  "type": "Bug",
  "priority": "High" | "Medium" | "Low",
  "platform": "one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach",
  "description": "Format with blank line between sections:\n\nSteps to reproduce:\n1. <step>\n2. <step>\n\nExpected behavior:\n- <expected>\n\nActual behavior:\n- <actual>\n\nEnvironment:\n- <browser/device/OS/app version if mentioned>\n\nNote: <any useful context, or N/A>",
  "assignee_names": ["Full Name of person assigned to fix — look for '@X check', 'nhờ @X', '@X fix this'. Empty array if unclear."]
}

Priority: High = crash/data loss/blocking QA, Medium = broken feature, Low = cosmetic/UI glitch`,
    messages: [{ role: 'user', content: `QA bug report:\n\n${context}` }],
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); }
  catch {
    return { summary: context.substring(0, 80), type: 'Bug', priority: 'Medium', platform: null, description: context, assignee_names: [] };
  }
}

// ── Build ADF description with links ─────────
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

// ── Create Jira issue ─────────────────────────
async function createJiraIssue(ticket, jiraAccountIds, epicKey, fixVersionId) {
  const fields = {
    project:     { key: JIRA_PROJECT },
    summary:     ticket.summary,
    issuetype:   { name: 'Bug' },
    priority:    { name: ticket.priority },
    description: buildAdfDescription(ticket.description),
  };

  // Parent (platform)
  const parentKey = PLATFORM_PARENTS[ticket.platform];
  if (parentKey) fields.parent = { key: parentKey };

  // Epic link
  if (epicKey) fields['customfield_10014'] = epicKey;

  // Fix version
  if (fixVersionId) fields.fixVersions = [{ id: fixVersionId }];

  // Assignee
  if (jiraAccountIds.length > 0) fields.assignee = { accountId: jiraAccountIds[0] };

  const res = await axios.post(`${JIRA_HOST}/rest/api/3/issue`, { fields }, {
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { key: res.data.key, url: `${JIRA_HOST}/browse/${res.data.key}` };
}

// ── Active sprint ─────────────────────────────
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

// ── Main: handle @qa-tracker mention ──────────
slackApp.event('app_mention', async ({ event, client, logger }) => {
  const botUserId  = (await client.auth.test()).user_id;
  const triggerText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();
  const threadTs   = event.thread_ts || event.ts;

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  try {
    // ── Handle Epic/FixVersion replies ────────
    // User is responding to a pending session prompt
    const session = pendingSession.get(threadTs);
    if (session) {
      const input = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

      if (session.step === 'awaiting_epic') {
        // Extract epic key from input (e.g. "PLAN-123" or "UP-456")
        const epicMatch = input.match(/[A-Z]+-\d+/i);
        session.epicKey = epicMatch ? epicMatch[0].toUpperCase() : null;
        session.step    = 'awaiting_fixversion';

        // Show available fix versions
        const versions = await getFixVersions();
        const versionList = versions.length > 0
          ? versions.map((v, i) => `*${i + 1}.* ${v.name} (ID: ${v.id})`).join('\n')
          : '_No active fix versions found_';

        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text:
            `✅ Epic set to: \`${session.epicKey || 'none'}\`\n\n` +
            `📦 Now, which *Fix Version* should this be added to?\n${versionList}\n\n` +
            `Reply with the version name or ID, or type \`skip\` to leave it blank.`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (session.step === 'awaiting_fixversion') {
        const versions = await getFixVersions();
        let fixVersionId = null;

        if (input.toLowerCase() !== 'skip') {
          // Match by ID or name
          const match = versions.find(v =>
            v.id === input.trim() ||
            v.name.toLowerCase().includes(input.toLowerCase())
          );
          fixVersionId = match?.id ?? null;
        }

        session.fixVersionId = fixVersionId;
        session.step         = 'creating';

        // Resolve assignees
        const jiraIds = (
          await Promise.all((session.assigneeSlackIds || []).map(id => resolveJiraAccountId(client, id)))
        ).filter(Boolean);

        // Create the ticket
        const jira = await createJiraIssue(session.ticket, jiraIds, session.epicKey, session.fixVersionId);

        // Add to active sprint
        const sprintId = await getActiveSprintId();
        if (sprintId) await addIssueToSprint(jira.key, sprintId);

        // Upload attachments
        let attachmentLine = '';
        if (session.attachments && session.attachments.length > 0) {
          let uploaded = 0;
          for (const att of session.attachments) {
            try {
              const buf = await downloadSlackFile(att.url);
              const ok  = await uploadAttachmentToJira(jira.key, att.name, buf, att.mimetype);
              if (ok) uploaded++;
            } catch (_) {}
          }
          if (uploaded > 0) attachmentLine = `\n📎 ${uploaded} attachment${uploaded > 1 ? 's' : ''} uploaded.`;
        }

        pendingSession.delete(threadTs);

        const assigneeLine = (session.assigneeSlackIds || []).length > 0
          ? `Assigned to ${session.assigneeSlackIds.map(id => `<@${id}>`).join(', ')}`
          : '_No assignee — please assign in Jira_';

        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text:
            `🐛 *Bug logged!* → <${jira.url}|${jira.key}>\n` +
            `*${session.ticket.summary}*\n` +
            `Priority: *${session.ticket.priority}* · Platform: *${session.ticket.platform || 'Unknown'}*\n` +
            attachmentLine + `\n\n` + assigneeLine,
        });

        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
        return;
      }
    }

    // ── Read thread context ───────────────────
    let context;
    if (event.thread_ts) {
      context = await getThread(client, event.channel, event.thread_ts);
    } else {
      context = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    }

    if (!context || context.trim().length < 10) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: '👋 Tag me *inside a QA bug thread* — I\'ll read the report and log it to Jira!',
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Parse the bug ─────────────────────────
    const ticket = await parseBugReport(context);
    logger.info(`[QABot] Parsed: ${ticket.summary} [${ticket.priority}]`);

    // ── Detect assignee ───────────────────────
    const triggerMentions = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
      .map(m => m.replace(/<@|>/g, ''))
      .filter(id => id !== botUserId);

    let assigneeSlackIds = triggerMentions;
    if (assigneeSlackIds.length === 0 && ticket.assignee_names?.length > 0) {
      // Try to find by name
      const usersRes = await client.users.list({ limit: 200 });
      for (const name of ticket.assignee_names) {
        const lower = name.toLowerCase();
        const match = (usersRes.members || []).find(u =>
          (u.real_name || '').toLowerCase().includes(lower) ||
          (u.profile?.display_name || '').toLowerCase().includes(lower)
        );
        if (match) assigneeSlackIds.push(match.id);
      }
    }

    // ── Get attachments from first message ────
    const attachments = await getFirstMessageAttachments(client, event.channel, threadTs);
    logger.info(`[QABot] Found ${attachments.length} attachment(s)`);

    // ── Store session, ask for Epic ───────────
    pendingSession.set(threadTs, {
      channelId:        event.channel,
      threadTs,
      ticket,
      attachments,
      assigneeSlackIds,
      epicKey:          null,
      fixVersionId:     null,
      step:             'awaiting_epic',
    });

    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs,
      text:
        `📋 Ready to log this bug:\n` +
        `*${ticket.summary}*\n` +
        `Priority: *${ticket.priority}* · Platform: *${ticket.platform || 'Unknown'}*\n` +
        (attachments.length > 0 ? `📎 ${attachments.length} attachment(s) will be uploaded\n` : '') +
        `\n🔗 Which *Epic* should this be linked to?\n` +
        `Reply with the Epic key (e.g. \`PLAN-123\` or \`UP-456\`), or type \`skip\` to leave it blank.`,
    });

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});

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
  console.log('✅ QABot running on port 3001');
})();
