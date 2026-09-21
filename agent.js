// ─────────────────────────────────────────────────────────────────────
// agent.js — QA Agent's real agent loop.
//
// Instead of routing a message into a fixed menu of hardcoded branches,
// the model is given TOOLS and a LOOP: it decides what to look at, reads
// the results, decides again, and acts — the way a human assistant (or
// Claude/ChatGPT with tools) works. New capabilities come from adding a
// tool, not writing a new pipeline.
// ─────────────────────────────────────────────────────────────────────
const axios = require('axios');
const {
  JIRA_HOST, JIRA_PROJECT, jiraAuth,
  aiComplete, getActiveSprintId, getIssueSnapshot, getProjectIssueTypes, createJiraIssueResilient,
  resolveInlineMentions, resolveUserName, gatherChannelContext, slackify,
} = require('./lib');

// ── Tool schemas the model sees ──────────────────────────────────────
const TOOLS = [
  { type: 'function', function: {
    name: 'read_channel_history',
    description: 'Read this Slack channel\'s recent threads (parents + replies, author names resolved) plus live Jira status for every ticket referenced. Use for any request about the channel, multiple threads, or a time window.',
    parameters: { type: 'object', properties: {
      days: { type: 'integer', description: 'How many days back (1-30). Default 14.' },
    } },
  } },
  { type: 'function', function: {
    name: 'jira_search',
    description: 'Search Jira with JQL. Returns key, summary, status, assignee, priority, updated. Examples: \'project = UP AND priority in (Highest, High) AND updated >= -14d ORDER BY updated DESC\', \'assignee = "Name" AND statusCategory != Done\'.',
    parameters: { type: 'object', required: ['jql'], properties: {
      jql: { type: 'string' },
      max_results: { type: 'integer', description: 'Default 20, max 50' },
    } },
  } },
  { type: 'function', function: {
    name: 'jira_get_issue',
    description: 'Get one Jira issue: status, assignee, summary, priority, description text, comments (latest 5).',
    parameters: { type: 'object', required: ['key'], properties: { key: { type: 'string', description: 'e.g. UP-79050' } } },
  } },
  { type: 'function', function: {
    name: 'jira_create_issue',
    description: 'Create a Jira ticket in project UP. It is placed in the Active Sprint automatically. Use markdown in description: ## headings, - bullets, 1. lists, **bold**.',
    parameters: { type: 'object', required: ['summary', 'description_markdown', 'issue_type'], properties: {
      summary: { type: 'string', description: 'Format: [Platform][Feature] Clear English title, <=100 chars' },
      description_markdown: { type: 'string' },
      issue_type: { type: 'string', description: 'Exact Jira issue type name as it exists in project UP — e.g. "Bug", "Task", "Product Task", "Story". An invalid name returns the list of valid types so you can retry.' },
      priority: { type: 'string', enum: ['Highest', 'High', 'Medium', 'Low'], description: 'Default Medium' },
      assignee_query: { type: 'string', description: 'Email or full name of the assignee (optional)' },
      epic_key: { type: 'string', description: 'Parent epic like UP-51189 (optional)' },
    } },
  } },
  { type: 'function', function: {
    name: 'jira_assign',
    description: 'Assign an existing Jira issue to a person.',
    parameters: { type: 'object', required: ['key', 'user_query'], properties: {
      key: { type: 'string' }, user_query: { type: 'string', description: 'Email or full name' },
    } },
  } },
  { type: 'function', function: {
    name: 'jira_transition',
    description: 'Move a Jira issue to a new status (e.g. "In Progress", "QA Ready", "Done"). Lists available transitions if the name does not match.',
    parameters: { type: 'object', required: ['key', 'status_name'], properties: {
      key: { type: 'string' }, status_name: { type: 'string' },
    } },
  } },
  { type: 'function', function: {
    name: 'jira_comment',
    description: 'Add a comment to a Jira issue.',
    parameters: { type: 'object', required: ['key', 'body'], properties: {
      key: { type: 'string' }, body: { type: 'string', description: 'Plain text/markdown-lite' },
    } },
  } },
  { type: 'function', function: {
    name: 'register_followup',
    description: 'Start follow-up tracking on a ticket in this thread: the agent pings the assignee every 2 business days, tags SM at QA Ready, PC at QA Success, until closed.',
    parameters: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } },
  } },
  { type: 'function', function: {
    name: 'delete_own_last_message',
    description: 'Delete the agent\'s own most recent message in this thread (when asked to retract/remove a reply).',
    parameters: { type: 'object', properties: {} },
  } },
];

const TOOL_STATUS = {
  read_channel_history: '📚 _reading the channel\'s recent threads…_',
  jira_search:          '🔎 _searching Jira…_',
  jira_get_issue:       '🔎 _checking the ticket in Jira…_',
  jira_create_issue:    '📝 _creating the Jira ticket…_',
  jira_assign:          '👤 _updating the assignee…_',
  jira_transition:      '🔁 _moving the ticket status…_',
  jira_comment:         '💬 _commenting on the ticket…_',
  register_followup:    '⏰ _setting up follow-up tracking…_',
  delete_own_last_message: '🧹 _removing my message…_',
};

// ── Tool implementations ─────────────────────────────────────────────
function mdToAdf(text) {
  // markdown-lite → ADF: ## headings, ordered/bullet lists, bold, links
  const lines = (text || '').split('\n').filter(l => l.trim() !== '');
  const inline = (line) => {
    line = line.replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
    const re = /\*\*([^*]+)\*\*|(https?:\/\/[^\s<>]+)/g;
    const parts = []; let last = 0, m;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push({ type: 'text', text: line.slice(last, m.index) });
      if (m[1] !== undefined) parts.push({ type: 'text', text: m[1], marks: [{ type: 'strong' }] });
      else parts.push({ type: 'text', text: m[2], marks: [{ type: 'link', attrs: { href: m[2] } }] });
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push({ type: 'text', text: line.slice(last) });
    return parts.length ? parts : [{ type: 'text', text: line }];
  };
  const content = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) { items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inline(lines[i].trim().replace(/^\d+\.\s+/, '')) }] }); i++; }
      content.push({ type: 'orderedList', content: items }); continue;
    }
    if (/^-\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^-\s/.test(lines[i].trim())) { items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inline(lines[i].trim().replace(/^-\s+/, '')) }] }); i++; }
      content.push({ type: 'bulletList', content: items }); continue;
    }
    if (line.startsWith('## ')) { content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: line.slice(3).trim() }] }); i++; continue; }
    content.push({ type: 'paragraph', content: inline(line) }); i++;
  }
  return { type: 'doc', version: 1, content };
}

async function jiraUserByQuery(q) {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/user/search`, {
      params: { query: q, maxResults: 5 },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const u = (res.data || []).find(x => x.active) || res.data?.[0];
    return u ? { accountId: u.accountId, displayName: u.displayName } : null;
  } catch { return null; }
}

async function execTool(name, args, ctx) {
  const { client, channelId, threadTs, registerFollowUp } = ctx;
  try {
    switch (name) {
      case 'read_channel_history': {
        const days = Math.min(Math.max(args.days || 14, 1), 30);
        const g = await gatherChannelContext(client, channelId, { days });
        return g.note ? { error: g.note } : { days, transcript: g.context };
      }
      case 'jira_search': {
        const res = await axios.get(`${JIRA_HOST}/rest/api/3/search`, {
          params: { jql: args.jql, maxResults: Math.min(args.max_results || 20, 50), fields: 'summary,status,assignee,priority,updated' },
          headers: { Authorization: jiraAuth(), Accept: 'application/json' },
        });
        return { total: res.data?.total, issues: (res.data?.issues || []).map(i => ({
          key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name,
          assignee: i.fields?.assignee?.displayName || null, priority: i.fields?.priority?.name,
          updated: i.fields?.updated, url: `${JIRA_HOST}/browse/${i.key}`,
        })) };
      }
      case 'jira_get_issue': {
        const res = await axios.get(`${JIRA_HOST}/rest/api/3/issue/${args.key}`, {
          params: { fields: 'summary,status,assignee,priority,description,comment' },
          headers: { Authorization: jiraAuth(), Accept: 'application/json' },
        });
        const f = res.data?.fields || {};
        const flat = []; (function walk(n) { if (!n) return; if (n.text) flat.push(n.text); if (Array.isArray(n.content)) n.content.forEach(walk); })(f.description);
        const comments = (f.comment?.comments || []).slice(-5).map(c => {
          const t = []; (function walk(n) { if (!n) return; if (n.text) t.push(n.text); if (Array.isArray(n.content)) n.content.forEach(walk); })(c.body);
          return { author: c.author?.displayName, text: t.join(' ').substring(0, 400) };
        });
        return { key: args.key, url: `${JIRA_HOST}/browse/${args.key}`, summary: f.summary, status: f.status?.name,
                 assignee: f.assignee?.displayName || null, priority: f.priority?.name,
                 description: flat.join(' ').substring(0, 2500), comments };
      }
      case 'jira_create_issue': {
        // Guardrail: a weaker model must not be ABLE to create duplicates.
        // Creation is allowed only if the user used creation language, or
        // the thread has no tickets yet (bare-tag logging).
        if (!ctx.allowCreate) {
          return { error: 'BLOCKED: the user did not ask for a new ticket and this thread already has ticket(s). Use register_followup / jira_assign / jira_comment on the existing ticket instead. If a new ticket is genuinely needed, tell the user to say "create ticket" or "force log".' };
        }
        // Validate the issue type against what actually exists in Jira —
        // invalid names return the valid list so the loop self-corrects.
        const types = await getProjectIssueTypes();
        const wanted = (args.issue_type || 'Bug').trim();
        const canonicalType = types.find(t => t.toLowerCase() === wanted.toLowerCase());
        if (!canonicalType) return { error: `Issue type "${wanted}" does not exist in project ${JIRA_PROJECT}.`, valid_types: types };
        const fields = {
          project: { key: JIRA_PROJECT },
          summary: (args.summary || '').substring(0, 250),
          issuetype: { name: canonicalType },
          priority: { name: args.priority || 'Medium' },
          description: mdToAdf(`${args.description_markdown || ''}\n\n## Reference\n- Slack thread: https://everfitt.slack.com/archives/${channelId}/p${String(threadTs).replace('.', '')}`),
          fixVersions: [{ id: '12023' }],
        };
        if (args.epic_key) fields.customfield_10014 = args.epic_key.toUpperCase();
        let assignee = null;
        if (args.assignee_query) {
          assignee = await jiraUserByQuery(args.assignee_query);
          if (assignee) fields.assignee = { accountId: assignee.accountId };
        }
        let createRes;
        try {
          createRes = await createJiraIssueResilient(fields);
        } catch (e) {
          return { error: e.message, field_errors: e.fieldErrors || null };
        }
        const key = createRes.key;
        const sprintId = await getActiveSprintId();
        if (sprintId && key) {
          await axios.post(`${JIRA_HOST}/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: [key] }, {
            headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json' },
          }).catch(() => {});
        }
        if (key && registerFollowUp) registerFollowUp({ channelId, threadTs, jiraKey: key, jiraUrl: `${JIRA_HOST}/browse/${key}`, squad: null });
        return { created: key, url: `${JIRA_HOST}/browse/${key}`,
                 assignee: assignee?.displayName || (args.assignee_query ? `NOT FOUND for "${args.assignee_query}" — created unassigned` : null),
                 sprint: sprintId ? 'Active Sprint' : 'no active sprint found',
                 adjustments: createRes.notes.length ? createRes.notes : undefined };
      }
      case 'jira_assign': {
        const u = await jiraUserByQuery(args.user_query);
        if (!u) return { error: `No Jira user found for "${args.user_query}"` };
        await axios.put(`${JIRA_HOST}/rest/api/3/issue/${args.key}/assignee`, { accountId: u.accountId }, {
          headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json' },
        });
        return { assigned: args.key, to: u.displayName };
      }
      case 'jira_transition': {
        const tRes = await axios.get(`${JIRA_HOST}/rest/api/3/issue/${args.key}/transitions`, {
          headers: { Authorization: jiraAuth(), Accept: 'application/json' },
        });
        const transitions = tRes.data?.transitions || [];
        const match = transitions.find(t => t.name.toLowerCase() === args.status_name.toLowerCase())
                   || transitions.find(t => t.to?.name?.toLowerCase() === args.status_name.toLowerCase());
        if (!match) return { error: `No transition to "${args.status_name}"`, available: transitions.map(t => t.name) };
        await axios.post(`${JIRA_HOST}/rest/api/3/issue/${args.key}/transitions`, { transition: { id: match.id } }, {
          headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json' },
        });
        return { moved: args.key, to: match.to?.name || match.name };
      }
      case 'jira_comment': {
        await axios.post(`${JIRA_HOST}/rest/api/3/issue/${args.key}/comment`, { body: mdToAdf(args.body || '') }, {
          headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json' },
        });
        return { commented: args.key };
      }
      case 'register_followup': {
        if (!ctx.registerFollowUp) return { error: 'follow-up registry unavailable' };
        ctx.registerFollowUp({ channelId, threadTs, jiraKey: args.key.toUpperCase(), jiraUrl: `${JIRA_HOST}/browse/${args.key.toUpperCase()}`, squad: null });
        return { tracking: args.key.toUpperCase() };
      }
      case 'delete_own_last_message': {
        const { user_id: botUid } = await client.auth.test();
        const replies = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 100 });
        const mine = (replies.messages || [])
          .filter(m => m.user === botUid && m.ts !== threadTs && m.ts !== ctx.excludeTs)  // never the live status message
          .sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
        if (!mine.length) return { error: 'no own message found in this thread' };
        await client.chat.delete({ channel: channelId, ts: mine[0].ts });
        return { deleted: mine[0].ts };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  } catch (err) {
    return { error: `${name} failed: ${err.response?.status || ''} ${err.response?.data?.errorMessages?.join('; ') || (err.response?.data?.errors ? JSON.stringify(err.response.data.errors) : '') || err.data?.error || err.message}`.trim() };
  }
}

// ── The loop ─────────────────────────────────────────────────────────
async function runAgent({ client, logger, channelId, threadTs, requesterId, requesterName, requestText, threadContext, existingKeys, status, registerFollowUp }) {
  const system = `You are QA Agent, Everfit's autonomous QA assistant living in Slack. You have tools — use them to actually accomplish what the teammate asks, the way a capable colleague would: check before assuming, act, then report what you did.

Facts about this request:
- Channel: <#${channelId}> · Requester: ${requesterName} (Slack ID ${requesterId}; "me"/"em"/"mình" means them; when assigning to them, use their name "${requesterName}" as assignee_query)
- Tickets already referenced in this thread: ${existingKeys.length ? existingKeys.join(', ') : 'none'}

Rules:
- ENGLISH output only. Slack formatting: *bold*, • bullets, <url|text> links. NO markdown headers. Refer to people by name, never raw Slack IDs.
- Ticket summaries: "[Platform][Feature] Clear English title". Descriptions use ## Bug Description / ## Root Cause / ## Expected Behavior / ## Steps to Reproduce for bugs; ## Context / ## Requirements for tasks — built from the actual thread details.
- Broken behavior → Bug. Data fix / config / account change / enable feature / export → Task.
- If the thread already has a ticket for the SAME issue, don't duplicate — check it, follow up, or say so. Create new tickets only for genuinely uncovered issues or when explicitly told ("force log", "new ticket anyway").
- Multiple distinct issues + a request to log them → one ticket per issue, each registered for follow-up (jira_create_issue does that automatically).
- Never invent tickets, links, statuses, or facts. If a tool errors, say what failed and what you did complete.
- TOOL DISCIPLINE: call only the tools whose effect the user actually asked for. "follow up with @X every N days" → register_followup (and jira_assign ONLY if the ticket is not already assigned to that person) — NEVER jira_create_issue. Status/progress questions → read-only tools. Do not take extra actions "to be helpful".
- Be decisive: for clear requests, act without asking permission. Ask at most one clarifying question and only when genuinely ambiguous.
- Final reply = a concise first-person report of what you did/found, with ticket links. No preamble.`;

  // Creation permission: explicit creation language, or a thread with no tickets yet
  const allowCreate =
    /\b(create|log|make|open|force|tạo|lên)\b/i.test(requestText) || existingKeys.length === 0;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `Thread transcript:\n${(threadContext || '(no thread — direct channel mention)').substring(0, 9000)}\n\nRequest from ${requesterName}: ${requestText}` },
  ];

  const executedTools = [];
  let retractSucceeded = false;

  for (let step = 0; step < 8; step++) {
    const res = await aiComplete({ model: 'gpt-4o', max_tokens: 1600, messages, tools: TOOLS, tool_choice: 'auto' });
    const msg = res.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || !msg.tool_calls.length) {
      // Delete-only requests get a silent ack (✅ reaction), not a narration
      if (retractSucceeded && executedTools.every(n => n === 'delete_own_last_message')) {
        return { __silent: true };
      }
      return slackify(msg.content?.trim()) || "I couldn't produce a result for that — try rephrasing.";
    }

    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
      if (status) await status.update(`🤖 QA Agent ${TOOL_STATUS[tc.function.name] || `_running ${tc.function.name}…_`}`);
      logger?.info?.(`[Agent] tool ${tc.function.name} ${JSON.stringify(args).substring(0, 200)}`);
      const out = await execTool(tc.function.name, args, { client, channelId, threadTs, registerFollowUp, allowCreate, excludeTs: status ? status.ts : null });
      executedTools.push(tc.function.name);
      if (tc.function.name === 'delete_own_last_message' && out && out.deleted) retractSucceeded = true;
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out).substring(0, 12000) });
    }
  }
  return "I hit my step limit before finishing — here's where I got to: " +
    (messages.filter(m => m.role === 'tool').slice(-2).map(m => m.content.substring(0, 300)).join(' · ') || 'no progress recorded');
}

module.exports = { runAgent };
