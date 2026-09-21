// ─────────────────────────────────────────────────────────────────────
// lib.js — shared components for QA Agent
// Single source of truth for everything used by BOTH handlers
// (index.js core + client-report.js module). Fix things here ONCE.
// ─────────────────────────────────────────────────────────────────────
const OpenAI = require('openai');
const axios  = require('axios');

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

function jiraAuth() {
  const token = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

// ── OpenAI with model-access fallback ────────────────────────────────
// The OpenAI project key may not have every model enabled (403 "does not
// have access to model"). Preferred smart model is configurable via env;
// any model-access failure falls back to gpt-4o-mini so the agent keeps
// working instead of erroring at the user.
let _openaiClient = null;
function getOpenAI() {
  if (!_openaiClient) _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openaiClient;
}
const SMART_MODEL = process.env.OPENAI_SMART_MODEL || 'gpt-4o';
let _smartModelBroken = false;

async function aiComplete(params) {
  const openai = getOpenAI();
  let model = params.model === 'gpt-4o' ? SMART_MODEL : params.model;
  if (_smartModelBroken && model !== 'gpt-4o-mini') model = 'gpt-4o-mini';
  try {
    return await openai.chat.completions.create({ ...params, model });
  } catch (err) {
    const msg = `${err?.message || ''}`;
    if (model !== 'gpt-4o-mini' && (err?.status === 403 || /does not have access to model/i.test(msg))) {
      if (!_smartModelBroken) console.warn(`[AI] Model "${model}" not enabled on this OpenAI project — falling back to gpt-4o-mini for all smart calls. Enable it in the OpenAI dashboard or set OPENAI_SMART_MODEL.`);
      _smartModelBroken = true;
      return await getOpenAI().chat.completions.create({ ...params, model: 'gpt-4o-mini' });
    }
    throw err;
  }
}

// Convenience wrapper (system + user → content string)
async function aiCall(system, userContent, maxTokens = 1000, jsonMode = false, model = 'gpt-4o-mini') {
  const res = await aiComplete({
    model,
    max_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: userContent },
    ],
  });
  return res.choices[0].message.content || '';
}

// ── Agent status: live progress message (animated working dots) ─────
function agentStatus(client, channel, threadTs) {
  let ts = null, base = '', dots = 0, timer = null, killer = null;
  const render = () => dots ? `${base} ${'·'.repeat(dots)}` : base;
  const stopTimers = () => { if (timer) clearInterval(timer); if (killer) clearTimeout(killer); timer = killer = null; };
  const del = async () => {
    stopTimers();
    if (!ts) return;
    const t = ts; ts = null;
    try { await client.chat.delete({ channel, ts: t }); } catch (_) {}
  };
  return {
    async start(text) {
      base = text; dots = 0;
      try {
        const r = await client.chat.postMessage({ channel, thread_ts: threadTs, unfurl_links: false, text: render() });
        ts = r.ts;
        // Animated working dots — edits the status every 2.5s so it feels alive
        timer = setInterval(async () => {
          if (!ts) return;
          dots = (dots + 1) % 4;
          try { await client.chat.update({ channel, ts, text: render() }); } catch (_) {}
        }, 2500);
        killer = setTimeout(del, 4 * 60 * 1000);   // safety net: a status can never orphan
      } catch (_) {}
    },
    async update(text) {
      base = text; dots = 0;
      if (!ts) return;
      try { await client.chat.update({ channel, ts, text: render() }); } catch (_) {}
    },
    async done() { await del(); },
  };
}

// ── Jira: Active Sprint (never "SM Review") ──────────────────────────
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

// ── Jira: quick issue snapshot ───────────────────────────────────────
async function getIssueSnapshot(issueKey) {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/issue/${issueKey}?fields=status,assignee,summary`, {
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const f = res.data?.fields || {};
    return { key: issueKey, status: f.status?.name || 'Unknown', assignee: f.assignee?.displayName || null, summary: f.summary || '' };
  } catch { return null; }
}

// ── Slack: resolve <@UID> mentions to real names (cached) ────────────
// Raw Slack IDs must never leak into AI context or replies.
const _userNameCache = new Map();
async function resolveUserName(client, uid) {
  if (_userNameCache.has(uid)) return _userNameCache.get(uid);
  let name = uid;
  try { name = (await client.users.info({ user: uid })).user?.real_name || uid; } catch (_) {}
  _userNameCache.set(uid, name);
  return name;
}
async function resolveInlineMentions(client, text) {
  const uids = [...new Set([...(text || '').matchAll(/<@([A-Z0-9]+)>/g)].map(m => m[1]))];
  let out = text || '';
  for (const uid of uids) out = out.split(`<@${uid}>`).join(`@${await resolveUserName(client, uid)}`);
  return out;
}

// ── General task worker: QA Agent does ANY requested knowledge work ──
async function qaTaskWork(context, userText) {
  try {
    const res = await aiComplete({
      model: SMART_MODEL, max_tokens: 1800,
      messages: [
        { role: 'system', content: `You are QA Agent, Everfit's autonomous QA assistant in Slack. A teammate tagged you in a thread with a work request. Do the work fully and directly — summarize, extract/list items, draft messages or announcements, translate, compare, plan tests, review, analyze — whatever they asked.

Rules:
- Output in ENGLISH only, regardless of the thread's language
- Use Slack formatting: *bold* for emphasis and section names, • for bullets; NO markdown headers (#)
- Refer to people by the names in the transcript. NEVER output raw Slack IDs like U07ABCDEF
- Be complete but not padded — deliver the work product itself, no preamble like "Here is the summary"
- If the thread doesn't contain enough information, deliver the best partial result and state clearly what is missing
- Never invent ticket numbers, links, or facts not present in the thread` },
        { role: 'user', content: `Thread transcript:\n${(context || '(no thread)').substring(0, 12000)}\n\nRequest: ${userText}` },
      ],
    });
    return res.choices[0].message.content?.trim() || null;
  } catch { return null; }
}

module.exports = {
  JIRA_HOST, JIRA_PROJECT, jiraAuth,
  SMART_MODEL, aiComplete, aiCall,
  agentStatus, getActiveSprintId, getIssueSnapshot,
  resolveUserName, resolveInlineMentions, qaTaskWork,
};
