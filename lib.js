// ─────────────────────────────────────────────────────────────────────
// lib.js — shared components for QA Agent
// Single source of truth for everything used by BOTH handlers
// (index.js core + client-report.js module). Fix things here ONCE.
// ─────────────────────────────────────────────────────────────────────
const OpenAI = require('openai');
const axios  = require('axios');

// Every Jira/Slack HTTP call gets a hard timeout. axios defaults to NO
// timeout, so one slow Jira response could hang a request forever — this
// was the 'stuck at creating tickets' failure. axios is a shared module
// instance, so this applies across all files.
axios.defaults.timeout = parseInt(process.env.HTTP_TIMEOUT_MS || '30000', 10);

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
  if (!_openaiClient) {
    _openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // Point at any OpenAI-compatible gateway (internal LB, LiteLLM, Azure
      // proxy...) by setting OPENAI_BASE_URL, e.g. https://codex-lb.internal/v1
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });
  }
  return _openaiClient;
}
const SMART_MODEL    = process.env.OPENAI_SMART_MODEL    || 'gpt-4o';
// One-line env truth at boot — ends 'which model/endpoint am I actually on?'
console.log(`[Boot] AI endpoint=${process.env.OPENAI_BASE_URL ? new URL(process.env.OPENAI_BASE_URL).host : 'api.openai.com'} smart=${process.env.OPENAI_SMART_MODEL || 'gpt-4o'} fallback=${process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini'} timeout=${process.env.OPENAI_TIMEOUT_MS || '90000'}ms key=${(process.env.OPENAI_API_KEY || '').slice(0, 6)}…`);
const FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini';
let _smartModelBroken = false;

// Gateway quirk flags — learned once, applied to all subsequent calls
let _useMaxCompletionTokens = false;
let _stripResponseFormat = false;

function _adaptParams(params) {
  const p = { ...params };
  // JSON mode requires the literal lowercase word "json" somewhere in the
  // messages (stricter models/gateways enforce this — gpt-6-astra returns
  // 400 otherwise, even when the prompt says "JSON" in caps).
  if (p.response_format?.type === 'json_object' && Array.isArray(p.messages)) {
    const hasJson = p.messages.some(m => typeof m.content === 'string' && m.content.includes('json'));
    if (!hasJson) {
      // Append to the LAST USER message: some gateways only scan user
      // content for the required lowercase 'json' token.
      p.messages = p.messages.map((m, i) =>
        i === p.messages.length - 1 && m.role === 'user' && typeof m.content === 'string'
          ? { ...m, content: `${m.content}\n\nReturn the result as a json object.` }
          : m);
      const stillMissing = !p.messages.some(m => typeof m.content === 'string' && m.content.includes('json'));
      if (stillMissing) p.messages = [...p.messages, { role: 'user', content: 'Return the result as a json object.' }];
    }
  }
  if (_useMaxCompletionTokens && p.max_tokens !== undefined) {
    p.max_completion_tokens = p.max_tokens;
    delete p.max_tokens;
  }
  if (_stripResponseFormat) delete p.response_format;
  return p;
}

// Hard per-call timeout: a hung gateway or a reasoning model chewing on a
// huge prompt must never freeze the bot. On timeout, smart calls retry once
// on the fast fallback model so the user still gets a result.
const AI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || '90000', 10);

async function aiComplete(paramsIn) {
  let params = paramsIn;
  const openai = getOpenAI();
  let model = params.model === 'gpt-4o' ? SMART_MODEL
            : params.model === 'gpt-4o-mini' ? FALLBACK_MODEL
            : params.model;
  if (_smartModelBroken && model !== FALLBACK_MODEL) model = FALLBACK_MODEL;

  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    const sysLen = (params.messages?.[0]?.content || '').length;
    const usrLen = (params.messages?.[params.messages.length - 1]?.content || '').length;
    console.log(`[AI] → ${model} max_tokens=${params.max_tokens || '-'} json=${!!params.response_format} tools=${params.tools ? params.tools.length : 0} sys=${sysLen}c user=${usrLen}c`);
    const heartbeat = setInterval(() => console.log(`[AI] … still waiting on ${model} (${Math.round((Date.now() - t0) / 1000)}s)`), 20000);
    try {
      const { __timeoutMs, __jsonWordRetried, ...callParams } = params;
      const res = await openai.chat.completions.create({ ..._adaptParams(callParams), model }, { timeout: __timeoutMs || AI_TIMEOUT_MS });
      clearInterval(heartbeat);
      console.log(`[AI] ← ${model} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return res;
    } catch (err) {
      clearInterval(heartbeat);
      const elapsed = Date.now() - t0;
      const isTimeout = err?.name === 'APIConnectionTimeoutError' || /timed?\s?out/i.test(`${err?.message || ''}`);
      if (isTimeout) {
        if (model !== FALLBACK_MODEL) {
          console.warn(`[AI] ${model} timed out after ${(elapsed / 1000).toFixed(0)}s — retrying on ${FALLBACK_MODEL}`);
          model = FALLBACK_MODEL;
          continue;
        }
        throw new Error(`AI call timed out after ${(elapsed / 1000).toFixed(0)}s on ${model}`);
      }
      const msg = `${err?.message || ''}`;
      // Reasoning models / some gateways: max_tokens → max_completion_tokens
      if (!_useMaxCompletionTokens && /max_tokens.*not supported|use ['"]?max_completion_tokens/i.test(msg)) {
        _useMaxCompletionTokens = true;
        console.warn('[AI] Endpoint wants max_completion_tokens — adapting all calls.');
        continue;
      }
      // Endpoint demands the literal word 'json' in the messages: inject it
      // into the user content and retry once, before giving up on JSON mode.
      if (params.response_format && /must contain the word\s+'?json'?/i.test(msg) && !params.__jsonWordRetried) {
        console.warn('[AI] Endpoint requires the literal word json in messages — injecting and retrying');
        params = {
          ...params,
          __jsonWordRetried: true,
          messages: [...params.messages, { role: 'user', content: 'Return the result as a json object.' }],
        };
        continue;
      }
      // Still refused → drop JSON mode entirely; prompts already demand json
      // and every caller brace-slices the response.
      if (!_stripResponseFormat && params.response_format &&
          (/must contain the word\s+'?json'?/i.test(msg) || /response_format|text\.format/i.test(msg))) {
        _stripResponseFormat = true;
        console.warn('[AI] Endpoint rejects response_format — stripping it for all calls.');
        continue;
      }
      if (model !== FALLBACK_MODEL && (err?.status === 403 || err?.status === 404 || /does not have access to model|model.*not found/i.test(msg))) {
        if (!_smartModelBroken) console.warn(`[AI] Model "${model}" unavailable on this endpoint — falling back to "${FALLBACK_MODEL}" for all smart calls. Fix model access or set OPENAI_SMART_MODEL / OPENAI_FALLBACK_MODEL.`);
        _smartModelBroken = true;
        model = FALLBACK_MODEL;
        continue;
      }
      throw err;
    }
  }
  throw new Error('aiComplete: exhausted parameter-adaptation retries');
}

// ── Tool-calling support probe (once per process) ────────────────────
// Some OpenAI-compatible gateways silently strip the tools parameter —
// the agent loop then gets a plain answer and honestly claims it cannot
// act. Detect that once so the loop can tell the truth about WHY.
let _toolsSupported = null;
async function toolsSupported() {
  if (_toolsSupported !== null) return _toolsSupported;
  try {
    const res = await aiComplete({
      model: 'gpt-4o-mini', max_tokens: 30,
      messages: [{ role: 'user', content: 'Call the ping tool.' }],
      tools: [{ type: 'function', function: { name: 'ping', description: 'test', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
    });
    _toolsSupported = !!res.choices?.[0]?.message?.tool_calls?.length;
  } catch (err) {
    _toolsSupported = false;
    console.warn('[AI] Tools probe errored:', err.message);
  }
  if (!_toolsSupported) console.warn('[AI] ⚠️ THIS ENDPOINT DOES NOT SUPPORT FUNCTION CALLING — the agent loop cannot act (read/create/assign in Jira). Check the gateway or switch OPENAI_BASE_URL.');
  else console.log('[AI] Tools probe OK — function calling supported.');
  return _toolsSupported;
}

// Convenience wrapper (system + user → content string)
async function aiCall(system, userContent, maxTokens = 1000, jsonMode = false, model = 'gpt-4o-mini', timeoutMs = null) {
  const res = await aiComplete({
    ...(timeoutMs ? { __timeoutMs: timeoutMs } : {}),
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
// Live action label, Claude-style: one first-person line stating the
// CURRENT step ("I'm searching Jira", "I'm creating the Jira ticket"),
// edited in place whenever the step changes. All phase texts are
// normalized here centrally — first person, no emoji, no ellipsis.
function _cleanStatus(text) {
  let t = (text || '').replace(/_/g, '').replace(/…/g, '').trim();
  t = t.replace(/^[^A-Za-z]+/, '').trim();                    // strip emoji / punctuation prefix
  t = t.replace(/^Dispatching to QA Agent.*$/i, 'on it');
  t = t.replace(/^QA Agent (is )?/i, '');                     // "QA Agent is X" → "X"
  t = t.replace(/^[^A-Za-z]+/, '').trim();                    // strip emoji again after prefix removal
  t = t.replace(/[.\s]+$/, '').trim();
  if (!t) return "I'm on it";
  if (!/^I(['’]m| am|\b)/i.test(t)) t = "I'm " + t.charAt(0).toLowerCase() + t.slice(1);
  return t;
}

function agentStatus(client, channel, threadTs) {
  // One italic line describing the CURRENT step, truthfully — it changes
  // whenever the work moves to a new step (per tool call in the agent
  // loop, per phase in the pipelines). No fake animation.
  let ts = null, killer = null;
  const del = async () => {
    if (killer) clearTimeout(killer);
    killer = null;
    if (!ts) return;
    const t = ts; ts = null;
    try { await client.chat.delete({ channel, ts: t }); } catch (_) {}
  };
  return {
    async start(text) {
      try {
        const r = await client.chat.postMessage({ channel, thread_ts: threadTs, unfurl_links: false, text: `_${_cleanStatus(text)}_` });
        ts = r.ts;
        killer = setTimeout(del, 4 * 60 * 1000);   // safety net: a status can never orphan
      } catch (_) {}
    },
    async update(text) {
      if (!ts) return;
      try { await client.chat.update({ channel, ts, text: `_${_cleanStatus(text)}_` }); } catch (_) {}
    },
    async done() { await del(); },
    get ts() { return ts; },
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

// ── Jira: project issue types (cached, from Jira itself) ─────────────
let _issueTypesCache = null, _issueTypesAt = 0;
async function getProjectIssueTypes(projectKey = JIRA_PROJECT) {
  const hit = _issueTypesCache && _issueTypesCache[projectKey];
  if (hit && Date.now() - _issueTypesAt < 3600 * 1000) return hit;
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/project/${projectKey}`, {
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const types = (res.data?.issueTypes || []).filter(t => !t.subtask).map(t => t.name);
    if (types.length) {
      _issueTypesCache = { ...(_issueTypesCache || {}), [projectKey]: types };
      _issueTypesAt = Date.now();
      return types;
    }
  } catch (_) {}
  return (hit) || (projectKey === JIRA_PROJECT ? ['Bug', 'Task'] : ['Idea']);
}

// ── Jira Product Discovery: create / update a discovery item ─────────
// Discovery boards (e.g. PLAN) use their own issue types ('Idea') and do
// NOT accept sprint / fixVersion / priority fields.
const DISCOVERY_PROJECT = process.env.DISCOVERY_PROJECT || 'PLAN';

async function createDiscoveryItem({ summary, descriptionMarkdown, projectKey = DISCOVERY_PROJECT }) {
  const types = await getProjectIssueTypes(projectKey);
  const type  = types.find(t => /idea/i.test(t)) || types[0] || 'Idea';
  const { key, notes } = await createJiraIssueResilient({
    project:     { key: projectKey },
    summary:     (summary || '').substring(0, 250),
    issuetype:   { name: type },
    description: mdToAdfDoc(descriptionMarkdown || ''),
  });
  return { key, url: `${JIRA_HOST}/browse/${key}`, type, notes };
}

async function updateIssueDescription(issueKey, descriptionMarkdown) {
  await axios.put(`${JIRA_HOST}/rest/api/3/issue/${issueKey}`,
    { fields: { description: mdToAdfDoc(descriptionMarkdown || '') } },
    { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json' } });
  return true;
}

async function addIssueComment(issueKey, markdown) {
  await axios.post(`${JIRA_HOST}/rest/api/3/issue/${issueKey}/comment`,
    { body: mdToAdfDoc(markdown || '') },
    { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json' } });
  return true;
}

// Minimal markdown → ADF (headings, bullets, numbered, bold, links)
function mdToAdfDoc(text) {
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
  const cellsOf = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const isSep   = (row) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(row.trim());
  while (i < lines.length) {
    const line = lines[i].trim();

    // Markdown table → ADF table (header row + separator + body rows)
    if (line.startsWith('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = cellsOf(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(cellsOf(lines[i])); i++; }
      const cell = (type, text) => ({ type, content: [{ type: 'paragraph', content: text ? inline(text) : [] }] });
      content.push({
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: [
          { type: 'tableRow', content: header.map(h => cell('tableHeader', h)) },
          ...rows.map(r => ({ type: 'tableRow', content: header.map((_, c) => cell('tableCell', r[c] || '')) })),
        ],
      });
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) { items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inline(lines[i].trim().replace(/^\d+\.\s+/, '')) }] }); i++; }
      content.push({ type: 'orderedList', content: items }); continue;
    }
    if (/^[-•]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-•]\s/.test(lines[i].trim())) { items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inline(lines[i].trim().replace(/^[-•]\s+/, '')) }] }); i++; }
      content.push({ type: 'bulletList', content: items }); continue;
    }
    const h = line.match(/^(#{2,4})\s+(.*)$/);
    if (h) { content.push({ type: 'heading', attrs: { level: Math.min(h[1].length, 3) }, content: [{ type: 'text', text: h[2].trim() }] }); i++; continue; }
    content.push({ type: 'paragraph', content: inline(line) }); i++;
  }
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }] };
}

// ── Jira: resilient issue creation ───────────────────────────────────
// Different issue types have different create screens: fields like
// fixVersions, priority, or the Epic Link custom field may not exist on
// a given type, and Jira rejects the WHOLE request with a 400. This
// helper retries, dropping or swapping the offending fields (Epic Link
// falls back to the modern parent link), so a valid ticket still gets
// created — and reports exactly what was adjusted.
// Find an issue created in the last few minutes with this exact summary —
// used to detect a create that succeeded despite a client-side timeout.
async function findRecentIssueBySummary(summary) {
  try {
    const safe = (summary || '').replace(/["\\]/g, ' ').substring(0, 180);
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/search`, {
      params: { jql: `project = ${JIRA_PROJECT} AND created >= -10m AND summary ~ "${safe}" ORDER BY created DESC`, maxResults: 1, fields: 'summary' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
      timeout: 15000,
    });
    return res.data?.issues?.[0]?.key || null;
  } catch { return null; }
}

async function createJiraIssueResilient(fields) {
  const notes = [];
  let lastErr = null;
  // "Epic Link" (legacy customfield_10014) and "parent" are two names for
  // the SAME relationship in Jira. Swapping between them is an internal
  // mechanism choice — done silently. Notes are only for GENUINE losses
  // the user should know about (a field omitted, a parent that failed
  // both ways).
  let triedEpicField = !!fields.customfield_10014;
  let triedParent = !!fields.parent;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const tCreate = Date.now();
      const res = await axios.post(`${JIRA_HOST}/rest/api/3/issue`, { fields }, {
        headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: parseInt(process.env.HTTP_TIMEOUT_MS || '30000', 10),
      });
      console.log(`[Jira] created ${res.data.key} in ${((Date.now() - tCreate) / 1000).toFixed(1)}s`);
      return { key: res.data.key, notes };
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data || {};
      const fieldErrors = data.errors || {};
      lastErr = { status, fieldErrors, messages: data.errorMessages || [] };

      // A client-side timeout does NOT mean Jira didn't create the issue.
      // Look for it by summary before retrying, so we never duplicate.
      if (!status && /timeout|timed out|ECONNABORTED/i.test(`${err.message || ''}`)) {
        console.warn('[Jira] create timed out client-side — checking whether it landed');
        const found = await findRecentIssueBySummary(fields.summary);
        if (found) {
          notes.push('Jira was slow to respond, but the ticket was created');
          return { key: found, notes };
        }
        throw new Error(`Jira create timed out and no matching issue was found: ${err.message}`);
      }
      if (status !== 400 || !Object.keys(fieldErrors).length) break;
      let fixed = false;
      for (const bad of Object.keys(fieldErrors)) {
        if (bad === 'customfield_10014' && fields.customfield_10014) {
          const key = fields.customfield_10014;
          delete fields.customfield_10014;
          if (!fields.parent && !triedParent) {
            fields.parent = { key };
            triedParent = true;
            console.log(`[Jira] Epic Link field rejected — retrying via parent ${key} (same relationship)`);
          } else {
            notes.push(`couldn't attach to ${key} — please link it in Jira`);
          }
          fixed = true;
        } else if (bad === 'parent' && fields.parent) {
          const key = fields.parent.key;
          delete fields.parent;
          if (!fields.customfield_10014 && !triedEpicField) {
            fields.customfield_10014 = key;
            triedEpicField = true;
            console.log(`[Jira] parent field rejected — retrying via Epic Link ${key} (same relationship)`);
          } else {
            notes.push(`couldn't attach to ${key} (${fieldErrors[bad]}) — please link it in Jira`);
          }
          fixed = true;
        } else if (fields[bad] !== undefined) {
          notes.push(`${bad} isn't supported on this issue type — omitted`);
          delete fields[bad];
          fixed = true;
        }
      }
      if (!fixed) break;
    }
  }
  const e = new Error(`Jira create failed (${lastErr?.status}): ${(lastErr?.messages || []).join('; ') || JSON.stringify(lastErr?.fieldErrors || {})}`);
  e.fieldErrors = lastErr?.fieldErrors;
  throw e;
}

// ── Jira: an issue's epic / parent link ──────────────────────────────
// Supports "same epic as that previous ticket" by inheriting the link
// from a ticket already in the thread. Checks both mechanisms.
async function getIssueEpic(issueKey) {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/issue/${issueKey}`, {
      params: { fields: 'customfield_10014,parent' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const f = res.data?.fields || {};
    return (typeof f.customfield_10014 === 'string' ? f.customfield_10014 : null) || f.parent?.key || null;
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
// Resolve MANY user IDs at once, in parallel, with a hard cap — sequential
// users.info calls inside a long thread loop was hanging whole requests.
async function warmUserNames(client, uids, { max = 60, concurrency = 8 } = {}) {
  const todo = [...new Set(uids)].filter(u => u && !_userNameCache.has(u)).slice(0, max);
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(async (uid) => {
      try {
        const info = await client.users.info({ user: uid });
        _userNameCache.set(uid, info.user?.real_name || uid);
      } catch { _userNameCache.set(uid, uid); }
    }));
  }
}

// Synchronous replacement using only the warmed cache (no API calls)
function replaceMentionsCached(text) {
  return (text || '').replace(/<@([A-Z0-9]+)>/g, (m, uid) => `@${_userNameCache.get(uid) || 'member'}`);
}

async function resolveInlineMentions(client, text) {
  const uids = [...new Set([...(text || '').matchAll(/<@([A-Z0-9]+)>/g)].map(m => m[1]))];
  await warmUserNames(client, uids);
  return replaceMentionsCached(text);
}

// ── Channel-scope context: recent threads + live Jira statuses ───────
// For requests like "review all critical issues in this channel last 2
// weeks" the current thread is not enough — gather the channel's recent
// threads into one transcript, plus live status for every ticket found.
const CHANNEL_SCOPE_RE = /\b(this channel|the channel|all threads?|threads? in|channel history|last\s+\d+\s+(?:days?|weeks?)|past\s+(?:week|\d+\s+weeks?)|recent threads?|c\u1ea3 k\u00eanh|k\u00eanh n\u00e0y|tu\u1ea7n (?:n\u00e0y|tr\u01b0\u1edbc|qua)|2 tu\u1ea7n)\b/i;

function detectChannelScope(text) {
  return CHANNEL_SCOPE_RE.test(text || '');
}

function parseWindowDays(text) {
  let m = (text || '').match(/(?:last|past)\s+(\d+)\s*weeks?/i);
  if (m) return Math.min(parseInt(m[1], 10) * 7, 30);
  m = (text || '').match(/(?:last|past)\s+(\d+)\s*days?/i);
  if (m) return Math.min(parseInt(m[1], 10), 30);
  if (/\b(?:last|past)\s+week\b|tu\u1ea7n tr\u01b0\u1edbc|tu\u1ea7n qua/i.test(text || '')) return 7;
  return 14;
}

async function gatherChannelContext(client, channelId, { days = 14, maxThreads = 30 } = {}) {
  const oldest = String((Date.now() - days * 24 * 3600 * 1000) / 1000);
  const blocks = [];
  const ticketKeys = new Set();
  try {
    const history = await client.conversations.history({ channel: channelId, oldest, limit: 200 });
    const parents = (history.messages || [])
      .filter(m => !m.bot_id || m.reply_count)          // humans, or bot threads with replies
      .sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))
      .slice(0, maxThreads);

    for (const parent of parents.reverse()) {            // oldest → newest
      const lines = [];
      const date = new Date(parseFloat(parent.ts) * 1000).toISOString().substring(0, 10);
      const push = async (m) => {
        const who = m.user ? await resolveUserName(client, m.user) : (m.bot_id ? 'QA Agent' : 'unknown');
        const txt = (await resolveInlineMentions(client, m.text || '')).replace(/\s+/g, ' ').substring(0, 400);
        if (txt) lines.push(`[${who}]: ${txt}`);
        for (const k of (m.text || '').match(/UP-\d+/g) || []) ticketKeys.add(k);
      };
      await push(parent);
      if (parent.reply_count) {
        try {
          const replies = await client.conversations.replies({ channel: channelId, ts: parent.ts, limit: 40 });
          for (const r of (replies.messages || []).slice(1)) await push(r);
        } catch (_) {}
      }
      blocks.push(`── Thread (${date}) ──\n${lines.join('\n').substring(0, 1600)}`);
    }
  } catch (err) {
    console.warn('[ChannelScope] history read failed:', err.data?.error || err.message);
    return { context: '', note: `I couldn't read this channel's history (${err.data?.error || err.message}) — I may be missing the groups:history scope for private channels.` };
  }

  // Live Jira status for every ticket referenced in the window
  const statuses = [];
  for (const key of [...ticketKeys].slice(0, 25)) {
    const snap = await getIssueSnapshot(key);
    if (snap) statuses.push(`${key} — ${snap.status}${snap.assignee ? ` — ${snap.assignee}` : ''} — ${snap.summary.substring(0, 90)}`);
  }

  const context =
    blocks.join('\n\n') +
    (statuses.length ? `\n\n── LIVE JIRA STATUS (current, from Jira) ──\n${statuses.join('\n')}` : '');
  return { context: context.substring(0, 30000), note: null };
}

// ── Deterministic fast-path triggers (shared by BOTH handlers) ───────
// Critical verbs must never depend on a model or gateway: creation,
// assignment, retraction. One source of truth — no more parity drift.
// Is this mention a ticket-creation request? ONE definition, used by both
// handlers to route creation to the single working pipeline.
// A discovery-board request: "log this into the Core Discovery board",
// "create a PLAN item", "update this into PLAN-123".
function isDiscoveryRequest(rawText) {
  const t = rawText || '';
  return FASTPATH.discovery.test(t) || /\bPLAN-\d+\b/i.test(t);
}

function isCreationRequest(rawText) {
  const t = (rawText || '').replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();
  return /^(force\s?log|create\s?(card|ticket|task)|log\s?(bug|this)|assign\s?to)/.test(t)
      || FASTPATH.creation.test(rawText || '')
      || FASTPATH.assignMention.test(rawText || '');
}

const FASTPATH = {
  creation:      /\b(create|log|make|tạo|lên)\b[^.]{0,40}\b(cards?|tickets?|bugs?|tasks?|issues?)\b/i,
  assignMention: /\b(assign|giao)\s+(to\s+|cho\s+)?<@/i,
  retract:       /\b(delete|remove|xóa|xoá)\b[^.]{0,40}\b(responses?|messages?|repl(y|ies)|tin nhắn)\b/i,
  discovery:     /\b(discovery|product\s+item|plan\s+item|idea|discovery\s+board|product\s+discovery)\b/i,
  followup:      /\b(follow[\s-]?up|theo\s?dõi|nhắc|check\s?(status|progress|tiến độ)|any\s?update)\b/i,
  retractAll:    /\ball\b|tất cả|hết|mọi tin/i,
  retractLastN:  /\blast\s+(\d+)\b/i,
};

// Shared retract executor: delete the agent's own message(s) in a thread.
// excludeTs protects a live status message; only messages older than
// beforeTs (the request) are eligible; thread root untouchable.
async function retractOwnMessages(client, channelId, threadTs, requestText, { beforeTs = null, excludeTs = null } = {}) {
  const { user_id: botUid } = await client.auth.test();
  const replies = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 100 });
  const mine = (replies.messages || [])
    .filter(m => m.user === botUid && m.ts !== threadTs && m.ts !== excludeTs
              && (!beforeTs || parseFloat(m.ts) < parseFloat(beforeTs)))
    .sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  if (!mine.length) return 0;
  const nMatch = (requestText || '').match(FASTPATH.retractLastN);
  const targets = FASTPATH.retractAll.test(requestText || '') ? mine.slice(0, 50)
                : mine.slice(0, nMatch ? Math.min(parseInt(nMatch[1], 10), 50) : 1);
  let deleted = 0;
  for (const m of targets) {
    try {
      await client.chat.delete({ channel: channelId, ts: m.ts });
      deleted++;
      if (targets.length > 3) await new Promise(r => setTimeout(r, 350));
    } catch (_) {}
  }
  return deleted;
}

// ── Client-report title convention ───────────────────────────────────
// Tickets logged from the client-report channels carry a leading tag so
// they're identifiable in Jira: [Client Report] for bugs,
// [Client Request] for tasks/requests. Applied deterministically in code
// (never left to the model) and idempotent.
function clientReportSummary(summary, issueType) {
  let s = (summary || '').trim();
  // strip any existing variant, however many times it appears
  s = s.replace(/^(?:\[(?:client\s*report|client\s*request|request)\]\s*)+/i, '').trim();
  const tag = /^bug$/i.test(issueType || '') ? '[Client Report]' : '[Client Request]';
  return `${tag}${s.startsWith('[') ? '' : ' '}${s}`.substring(0, 250);
}

// ── slackify: normalize AI output for Slack ──────────────────────────
// Models (especially gpt-4o-mini) leak markdown: **bold**, ### headers,
// [text](url). Slack needs *bold* and <url|text>. Also auto-link every
// bare Jira key so UP-78287 is always clickable.
function slackify(text) {
  if (!text) return text;
  let out = text;
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>');   // [t](url) → <url|t>
  out = out.replace(/^#{1,4}\s+(.+)$/gm, '*$1*');                          // headers → bold
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');                        // **b** → *b*
  out = out.replace(/(<[^>]*>)|\b(UP|PLAN)-(\d+)\b/g, (m, link, proj, num) =>
    link ? link : `<${JIRA_HOST}/browse/${proj}-${num}|${proj}-${num}>`);  // bare keys → links
  return out;
}

// ── General task worker: QA Agent does ANY requested knowledge work ──
async function qaTaskWork(context, userText, maxChars = 12000) {
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
        { role: 'user', content: `Transcript (may contain MULTIPLE threads from the channel, plus a LIVE JIRA STATUS section — treat that section as the current source of truth for ticket status):\n${(context || '(no thread)').substring(0, maxChars)}\n\nRequest: ${userText}` },
      ],
    });
    return slackify(res.choices[0].message.content?.trim()) || null;
  } catch { return null; }
}

module.exports = {
  JIRA_HOST, JIRA_PROJECT, jiraAuth,
  SMART_MODEL, aiComplete, aiCall, toolsSupported,
  agentStatus, getActiveSprintId, getIssueSnapshot, getProjectIssueTypes, createJiraIssueResilient, getIssueEpic,
  resolveUserName, resolveInlineMentions, warmUserNames, replaceMentionsCached, qaTaskWork,
  detectChannelScope, parseWindowDays, gatherChannelContext,
  slackify, FASTPATH, retractOwnMessages, isCreationRequest, isDiscoveryRequest, clientReportSummary,
  DISCOVERY_PROJECT, createDiscoveryItem, updateIssueDescription, addIssueComment, mdToAdfDoc,
};
