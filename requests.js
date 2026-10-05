// ─────────────────────────────────────────────────────────────────────
// requests.js — follow every production release request until it's done.
//
// #release_production_request runs a workflow per release: each step is a
// workflow message naming who must act ('… press `Continue`', 'please
// *approve*', '… click *PASSED*', 'press `Done`'), and the workflow appends
// '<@X> clicked *Continue*' when it's done. The last step says 'Release
// already finished'.
//
// Every 15 minutes (working hours) the bot reads each open request thread:
//  · the pending step, since when, and who it waits on → reminders in the
//    thread after 30 min, at most hourly, 3 per step; fyi the approvers from
//    the 2nd reminder on
//  · a blocker noted by someone ('Dependency: Waiting API 4.32.0') → no
//    nagging; it reports that dependency's request status instead, and says
//    when it's finished
//  · finished → if the Jira version isn't marked released, offer the button
// State lives in the thread (the bot's own messages), so restarts are safe.
// ─────────────────────────────────────────────────────────────────────
const axios = require('axios');
const lib = require('./lib');
const { JIRA_HOST, jiraAuth } = lib;

const CHANNEL = process.env.PROD_RELEASE_CHANNEL || 'CTT4J643Y';
const APPROVERS = (process.env.RELEASE_APPROVERS || 'U0142GU335F,U0445EQS1ED').split(',').map(s => s.trim()).filter(Boolean);
const REMIND_AFTER_MIN = parseInt(process.env.REQ_REMIND_AFTER_MIN || '30', 10);
const REMIND_EVERY_MIN = parseInt(process.env.REQ_REMIND_EVERY_MIN || '120', 10);
const MAX_REMINDERS    = parseInt(process.env.REQ_MAX_REMINDERS || '2', 10);
const LOOKBACK_DAYS    = parseInt(process.env.REQ_LOOKBACK_DAYS || '7', 10);
const STALE_AFTER_MIN  = parseInt(process.env.REQ_STALE_AFTER_MIN || String(2 * 24 * 60), 10);   // 2 days
const REMINDED = new Map();   // '<request ts>:<step ts>' → { count, at } — guard even if the thread read misses one
const MARK = '⏳ This release is waiting';          // marker on the bot's reminders
// Slack stores ⏳ as ':hourglass_flowing_sand:' — the old includes(MARK)
// check never matched, so reminders were never counted (every 15 min, no cap)
const MARK_RE = /(?:⏳|:hourglass_flowing_sand:)\s*This release is waiting/;
const isReminder = (m) => MARK_RE.test(m?.text || '');
const vn = () => new Date(Date.now() + 7 * 3600 * 1000);
const hhmm = (ts) => new Date(parseFloat(ts) * 1000 + 7 * 3600 * 1000).toISOString().substring(11, 16);
const mins = (ts) => Math.round((Date.now() / 1000 - parseFloat(ts)) / 60);
const dur = (m) => m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
const link = (ts) => `https://everfitt.slack.com/archives/${CHANNEL}/p${String(ts).replace('.', '')}`;

// The workflow keeps parts of a step (e.g. '<@X> clicked *Continue*') in its
// blocks, not in .text — read everything.
function fullText(m) {
  const out = [m.text || ''];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.text === 'string') out.push(n.text);
    else if (n.text && typeof n.text.text === 'string') out.push(n.text.text);
    if (n.type === 'user' && n.user_id) out.push(`<@${n.user_id}>`);
    if (n.type === 'usergroup' && n.usergroup_id) out.push(`<!subteam^${n.usergroup_id}>`);
    for (const k of ['elements', 'fields', 'blocks']) if (n[k]) walk(n[k]);
  };
  walk(m.blocks); walk(m.attachments);
  return out.join('\n');
}
// Buttons still on the message = the step is waiting for that click
function pendingButtons(m) {
  const labels = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'button' && n.text?.text) labels.push(n.text.text.trim());
    for (const k of ['elements', 'blocks', 'actions']) if (n[k]) walk(n[k]);
  };
  walk(m.blocks); walk(m.attachments);
  return labels;
}

// ── Reading a request thread ─────────────────────────────────────────
const ACTION_RE = /(?:press|click)[^`*\n]{0,25}[*`]+\s*(continue|done|passed|confirm|completed?|approve)\b|\*`?(approve)`?\*|\b(approve)\b[^.\n]*\brelease\b|\*`?(PASSED)`?\*|`(continue|done|confirm|completed?)`/i;
function actionOf(text) {
  const m = (text || '').match(ACTION_RE);
  const a = (m && (m[1] || m[2] || m[3] || m[4] || m[5]) || '').toLowerCase();
  return a === 'passed' ? 'PASSED' : a ? a[0].toUpperCase() + a.slice(1) : null;
}
function stepLabel(text) {
  const t = (text || '').toLowerCase().replace(/[*`_~]/g, '');   // '*`approve`* this release request'
  if (/list out all (?:the )?cards/.test(t)) return 'list the cards in this release';
  if (/approve this release request/.test(t)) return 'approve the release request';
  if (/release checklist/.test(t)) return 'send the release checklist';
  if (/list out all action items/.test(t)) return 'list the action items';
  if (/regression test/.test(t)) return 'confirm the regression test on staging';
  if (/sanity test/.test(t)) return 'do the sanity test on staging';
  if (/test is passed on staging/.test(t)) return 'confirm the test passed on staging';
  if (/deploy the release to production/.test(t)) return 'approve the deploy to production';
  if (/start rolling out/.test(t)) return 'start rolling out';
  if (/rolling started/.test(t)) return 'finish the rollout (env, migration)';
  if (/smoke test/.test(t)) return 'smoke test on production';
  return 'the next step';
}
const doneLine = (text) => /<@[A-Z0-9]+(?:\|[^>]*)?>\s*clicked\s*\*?`?\w+/i.test(text || '');
// Who the step waits on: people/groups named before any 'fyi'
// A thank-you is not an ask: 'Thank <@Bao> for your approval. … @qa please
// send the release checklist' waits on @qa, not Bao.
const THANKS_RE = /\bthanks?(?:\s+you)?\s*(?:(?:,|and|&)?\s*<@[A-Z0-9]+(?:\|[^>]*)?>\s*)+/gi;
function waitingOn(text) {
  const head = (text || '').split(/\bfyi\b/i)[0].replace(/<@[A-Z0-9]+(?:\|[^>]*)?>\s*clicked[\s\S]*$/i, '').replace(THANKS_RE, ' ');
  return [...new Set((head.match(/<@[A-Z0-9]+(?:\|[^>]*)?>|<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>/g) || []).map(m => m.replace(/\|[^>]*>/, '>')))];
}
function requestName(parentText) {
  const m = (parentText || '').match(/for platform:\s*(.+?)\s*-\s*version:\s*([A-Za-z_]*v?\d+(?:\.\d+){1,3})/i);
  return m ? `${m[1].trim()} ${m[2].replace(/^v/i, '')}`.replace(/\s+/g, ' ') : 'this release';
}

const CANCEL_RE = /\b(?:release|request|ver(?:sion)?|bản|cái\s+ni|cái\s+này)\b[^.\n]{0,40}\b(?:cancel(?:led|ed)?|h[uủ]y|hủy|won'?t\s+go|not\s+going)\b|\bcancel(?:led|ed)\b|(?:ko|không|k)\s+đi\s+nữa|\bignore\s+(?:gi[ùu]m|giúp|this|it)\b|\bkhông\s+release\s+nữa\b/i;

function readThread(msgs, botUid) {
  const parent = msgs[0];
  const workflow = msgs.filter(m => m.bot_id && m.user !== botUid);          // the release workflow's messages
  const finished = workflow.some(m => /release already finished/i.test(fullText(m)));
  // The pending step: the latest workflow message with an action and no 'clicked' line
  let pending = null;
  for (const m of [...workflow].reverse()) {
    const t = fullText(m);
    if (doneLine(t)) break;                                                  // everything up to here is done
    const buttons = pendingButtons(m);
    if (buttons.length || actionOf(t)) { pending = { ...m, text: t, _action: buttons[0] || actionOf(t) }; break; }
  }
  const mine = msgs.filter(m => m.user === botUid || (m.bot_id && /^⏳|^Blocked:|^Release finished/.test(m.text || '')));
  // Only reminders that point at THIS step count (a stale or misread one doesn't)
  const pointsAt = (m) => ((m.text || '').match(/archives\/[A-Z0-9]+\/p(\d{10})(\d{6})/) || []).slice(1).join('.');
  const remindersForStep = pending ? mine.filter(m => isReminder(m) && pointsAt(m) === pending.ts) : [];
  // Cancelled: the bot's own 'Stopped following' marker, or someone saying so
  // after the pending step ('ko đi nữa', 'ignore giùm', 'release cancelled').
  // Only messages AFTER the step count, so a feature named 'Cancel
  // Subscription' in the release notes doesn't.
  const after = pending ? msgs.filter(m => !m.bot_id && parseFloat(m.ts) > parseFloat(pending.ts)) : [];
  const cancelled = mine.some(m => /^Stopped following this release request/.test(m.text || ''))
    || after.some(m => CANCEL_RE.test((m.text || '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, ' ')));
  // A blocker someone noted after the step started
  const blocker = pending && msgs.filter(m => !m.bot_id && parseFloat(m.ts) > parseFloat(pending.ts))
    .reverse().find(m => /\b(?:waiting|dependency|blocked|depends on|chờ|đợi)\b/i.test(m.text || '') && !CANCEL_RE.test(m.text || ''));
  return { parent, finished, pending, remindersForStep, blocker, mine, cancelled };
}

// ── The person in charge, not the whole group ────────────────────────
// A step often tags a group ('@qa Let's do the smoke test…'). The person in
// charge of THIS release for that role is usually known from the thread:
// who clicked or was named in the earlier steps of that role, or posted the
// checklist (QA) / the action items (dev). Else Jira: the QA field (QA) or
// the main assignee (dev) on the version's cards. Group only as a fallback.
function roleOfStep(label) {
  if (/checklist|test passed on staging|regression|smoke test/.test(label)) return 'qa';
  if (/sanity/.test(label)) return 'ba';
  if (/list the cards|action items|rolling out|rollout/.test(label)) return 'dev';
  if (/approve/.test(label)) return 'approver';
  return null;
}
function personInChargeFromThread(msgs, botUid, role, beforeTs) {
  let found = null;
  for (const m of msgs) {
    if (parseFloat(m.ts) >= parseFloat(beforeTs)) break;
    const t = fullText(m);
    if (m.bot_id && m.user !== botUid) {
      // The request's first step is always the dev's (whoever opened it)
      const stepRole = m === msgs[0] ? 'dev' : roleOfStep(stepLabel(t));
      if (stepRole !== role) continue;
      const clicker = (t.match(/<@([A-Z0-9]+)(?:\|[^>]*)?>\s*clicked/) || [])[1];
      const named = waitingOn(t).filter(x => x.startsWith('<@')).map(x => x.slice(2, -1));
      const pick = [clicker, ...named].find(id => id && !APPROVERS.includes(id));
      found = pick || found;
    } else if (!m.bot_id && m.user && !APPROVERS.includes(m.user)) {
      if (role === 'qa' && /release\s+checklist|checklist/i.test(t)) found = m.user;
      if (role === 'dev' && /^\s*(?:actions?\s*:|release notes)/im.test(t)) found = m.user;
    }
  }
  return found;
}
async function personInChargeFromJira(client, parentText, role) {
  if (role !== 'qa' && role !== 'dev') return null;
  const v = await jiraVersionFor(parentText);
  if (!v) return null;
  const r = await axios.get(`${JIRA_HOST}/rest/api/3/search/jql`, {
    params: { jql: `fixVersion = ${v.id}`, maxResults: 100, fields: 'assignee,customfield_10131' },
    headers: { Authorization: jiraAuth(), Accept: 'application/json' },
  }).catch(() => ({ data: { issues: [] } }));
  const names = (r.data?.issues || []).map(i => role === 'qa' ? i.fields?.customfield_10131?.displayName : i.fields?.assignee?.displayName).filter(Boolean);
  const ranked = Object.entries(names.reduce((a, n) => ((a[n] = (a[n] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  for (const n of ranked) {
    const id = await require('./release').slackIdByName(client, n);
    if (id && !APPROVERS.includes(id)) return id;          // not the approvers — they aren't doing the QA / dev work
  }
  return null;
}
async function whoToTag(client, msgs, botUid, pending, label) {
  const role = roleOfStep(label);
  // The approvers only act on approval steps — a QA or dev step that mentions
  // them is thanking or cc'ing them, not waiting on them
  const named = waitingOn(pending.text).filter(x => !role || role === 'approver' || !APPROVERS.some(a => x === `<@${a}>`));
  if (named.some(x => x.startsWith('<@'))) return { tags: named.filter(x => x.startsWith('<@')), how: 'named in the step' };
  const person = (role && personInChargeFromThread(msgs, botUid, role, pending.ts)) || await personInChargeFromJira(client, msgs[0]?.text, role).catch(() => null);
  if (person) return { tags: [`<@${person}>`], how: 'in charge of this release' };
  return { tags: named, how: 'the group named in the step' };
}

// ── Dependencies ('Waiting API 4.32.0') ──────────────────────────────
const DEP_RE = /\b(Web|API|Android|iOS|Middleware|Internal\s*API|Academy(?:\s*(?:Web|CMS))?|CMS|Landing(?:\s*Page)?|olly|MP\s*API)\s*(?:(Coach|Client)[_\s]*)?v?(\d+(?:\.\d+){1,3})\b/i;
function depOf(text) {
  const m = (text || '').match(DEP_RE);
  return m ? { platform: m[1].replace(/\s+/g, ' '), side: m[2] || null, version: m[3] } : null;
}
function sameRelease(parentText, dep) {
  const m = (parentText || '').match(/for platform:\s*(.+?)\s*-\s*version:\s*([A-Za-z_]*)v?(\d+(?:\.\d+){1,3})/i);
  if (!m) return false;
  const p = m[1].toLowerCase().replace(/[^a-z]/g, ''), d = dep.platform.toLowerCase().replace(/[^a-z]/g, '');
  return (p === d || (d === 'landing' && p === 'landingpage')) && m[3] === dep.version &&
    (!dep.side || (m[2] || '').toLowerCase().startsWith(dep.side.toLowerCase()));
}

// ── Jira: is the finished release marked released? ───────────────────
let _versions = null, _versionsAt = 0;
async function jiraVersionFor(parentText) {
  if (!_versions || Date.now() - _versionsAt > 10 * 60 * 1000) {
    _versions = await axios.get(`${JIRA_HOST}/rest/api/3/project/UP/versions`, { headers: { Authorization: jiraAuth(), Accept: 'application/json' } })
      .then(r => r.data || []).catch(() => []);
    _versionsAt = Date.now();
  }
  const m = (parentText || '').match(/for platform:\s*(.+?)\s*-\s*version:\s*([A-Za-z_]*v?\d+(?:\.\d+){1,3})/i);
  if (!m) return null;
  const names = require('./release').requestToVersionNames(m[1], m[2]).map(n => n.toLowerCase());
  return _versions.find(v => names.includes((v.name || '').toLowerCase())) || null;
}

// Slack adds block_id / verbatim / emoji to blocks it stores — drop those
// so a posted message compares equal to the one we'd post again
function stripBlock(b) {
  const clean = (n) => Array.isArray(n) ? n.map(clean) : (n && typeof n === 'object')
    ? Object.fromEntries(Object.entries(n).filter(([k]) => !['block_id', 'verbatim', 'emoji'].includes(k)).map(([k, v]) => [k, clean(v)])) : n;
  return clean(b);
}

// ── One pass over the channel ────────────────────────────────────────
function inHours() {
  const d = vn(), dow = d.getUTCDay(), hm = d.getUTCHours() * 60 + d.getUTCMinutes();
  return dow !== 0 && dow !== 6 && hm >= 8 * 60 + 30 && hm <= 20 * 60;
}

async function scan(client, { force = false, onlyTs = null, logger = console } = {}) {
  if (!force && !inHours()) return [];
  const { user_id: botUid } = await client.auth.test();
  const oldest = String((Date.now() - LOOKBACK_DAYS * 86400 * 1000) / 1000);
  const hist = await client.conversations.history({ channel: CHANNEL, oldest, limit: 200 }).catch(() => ({ messages: [] }));
  const parents = (hist.messages || []).filter(m => m.bot_id && /Release Request\*?\s*for platform/i.test(m.text || '') && (!onlyTs || m.ts === onlyTs));
  const threads = new Map();
  for (const p of parents) {
    const rr = await client.conversations.replies({ channel: CHANNEL, ts: p.ts, limit: 200 }).catch(() => ({ messages: [p] }));
    threads.set(p.ts, rr.messages || [p]);
  }
  const report = [];
  for (const p of parents) {
    const msgs = threads.get(p.ts);
    const s = readThread(msgs, botUid);
    const name = requestName(p.text);
    if (s.cancelled) {
      // Clean up my reminders once, then leave it alone
      for (const r of s.mine.filter(m => isReminder(m))) await client.chat.delete({ channel: CHANNEL, ts: r.ts }).catch(() => {});
      report.push({ name, state: 'cancelled', ts: p.ts });
      continue;
    }
    // Finished → Jira released? Only offer the button once every card on the
    // version is QA Success (or Done/Released/Closed); until then the one
    // 'Release finished' message lists the cards still open, and is kept up
    // to date each pass — it turns into the button when they're all done.
    if (s.finished) {
      const v = await jiraVersionFor(p.text);
      const prev = s.mine.filter(m => /^Release finished/.test(m.text || '')).pop();
      if (v && !v.released) {
        const R = require('./release');
        let open = [];
        try { open = await R.notReadyCards(client, v.id); } catch (_) { open = null; }   // lookup failed → don't offer the button blind
        const day = new Date(parseFloat(msgs.find(m => /release already finished/i.test(fullText(m)))?.ts || p.ts) * 1000 + 7 * 3600 * 1000).toISOString().substring(0, 10);
        let text, blocks;
        if (open && open.length) {
          text = `Release finished — ${v.name} can't be marked released in Jira yet: ${open.length} card(s) aren't QA Success.`;
          blocks = [{ type: 'section', text: { type: 'mrkdwn', text: (`Release finished — *${v.name}* can't be marked released in Jira yet: ${open.length} card(s) aren't QA Success:\n` +
            `${open.slice(0, 15).map(R.notReadyLine).join('\n')}${open.length > 15 ? `\n_…and ${open.length - 15} more_` : ''}\n` +
            `I'll offer the button here once they're QA Success. ${APPROVERS.map(u => `<@${u}>`).join(' ')}`).substring(0, 2900) } }];
        } else if (open) {
          text = `Release finished — ${v.name} isn't marked released in Jira yet.`;
          blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `Release finished — *${v.name}* isn't marked released in Jira yet — all its cards are QA Success. ${APPROVERS.map(u => `<@${u}>`).join(' ')}` } },
            { type: 'actions', elements: [{ type: 'button', style: 'primary', action_id: `rel_mark_released_${v.id}`, value: `${v.id}|${day}|${v.name}`,
              text: { type: 'plain_text', text: `Mark ${v.name} released`.substring(0, 75) } }] }];
        }
        if (text && !prev) {
          await client.chat.postMessage({ channel: CHANNEL, thread_ts: p.ts, unfurl_links: false, text, blocks }).catch(() => {});
        } else if (text && prev && JSON.stringify(blocks) !== JSON.stringify((prev.blocks || []).map(stripBlock))) {
          await client.chat.update({ channel: CHANNEL, ts: prev.ts, text, blocks }).catch(() => {});
        }
      }
      report.push({ name, state: 'finished', ts: p.ts, jiraReleased: v ? !!v.released : null });
      continue;
    }
    // A reminder of mine that points at a step which isn't the pending one
    // (it's done, or I misread it) is removed — no stale nagging in the thread
    for (const r of s.mine.filter(m => isReminder(m))) {
      const pointed = ((r.text || '').match(/archives\/[A-Z0-9]+\/p(\d{10})(\d{6})/) || []).slice(1).join('.');
      if (pointed && (!s.pending || pointed !== s.pending.ts)) {
        await client.chat.delete({ channel: CHANNEL, ts: r.ts }).catch(() => {});
        logger.info?.(`[Requests] Removed a stale reminder in ${name}`);
      }
    }
    if (!s.pending) { report.push({ name, state: 'in progress', ts: p.ts }); continue; }
    const step = stepLabel(s.pending.text), action = s.pending._action || 'the button', since = s.pending.ts, waited = mins(since);
    const who = (await whoToTag(client, msgs, botUid, s.pending, step)).tags;
    // Blocked by a dependency someone noted
    if (s.blocker) {
      const dep = depOf(s.blocker.text);
      let depLine = '';
      if (dep) {
        const depParent = [...threads.entries()].filter(([, ms]) => sameRelease(ms[0].text, dep) && !readThread(ms, botUid).cancelled)
          .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))[0];
        if (!depParent) depLine = `No release request for ${dep.platform} ${dep.version} yet.`;
        else {
          const ds = readThread(depParent[1], botUid);
          depLine = ds.finished ? `${dep.platform} ${dep.version} is finished — you can continue now.` : `${dep.platform} ${dep.version} is at: *${ds.pending ? stepLabel(ds.pending.text) : 'in progress'}* (<${link(depParent[0])}|request>).`;
          if (ds.finished) {
            const said = s.mine.some(m => /is finished — you can continue now/.test(m.text || '') && parseFloat(m.ts) > parseFloat(s.blocker.ts));
            if (!said) await client.chat.postMessage({ channel: CHANNEL, thread_ts: p.ts, unfurl_links: false, text: `${who.join(' ')} ${depLine} Next: *${step}* — press *${action}* above.` }).catch(() => {});
            report.push({ name, state: `waiting on ${step}`, ts: p.ts, blockedBy: `${dep.platform} ${dep.version} (finished)` });
            continue;
          }
        }
      }
      const lastBlockedNote = s.mine.filter(m => /^Blocked:/.test(m.text || '')).pop();
      if (force || !lastBlockedNote || mins(lastBlockedNote.ts) >= 120) {
        await client.chat.postMessage({ channel: CHANNEL, thread_ts: p.ts, unfurl_links: false,
          text: `Blocked: *${step}* is on hold — ${dep ? `waiting on ${dep.platform} ${dep.version}` : 'a dependency was noted'} (since ${hhmm(s.blocker.ts)}). ${depLine}` }).catch(() => {});
      }
      report.push({ name, state: `on hold: ${step}`, ts: p.ts, blockedBy: dep ? `${dep.platform} ${dep.version}` : 'noted dependency' });
      continue;
    }
    // Pending for days and never reminded → it's stale, not something to nag about now
    if (!force && waited > STALE_AFTER_MIN && !s.remindersForStep.length) {
      report.push({ name, state: `stale: ${step}`, ts: p.ts, waited, who, action });
      continue;
    }
    report.push({ name, state: `waiting on ${step}`, ts: p.ts, waited, who, action });
    // Only the latest reminder for this step stays in the thread
    for (const old of s.remindersForStep.slice(0, -1)) await client.chat.delete({ channel: CHANNEL, ts: old.ts }).catch(() => {});
    // Reminder?
    if (!force && waited < REMIND_AFTER_MIN) continue;
    const last = s.remindersForStep[s.remindersForStep.length - 1];
    const guardKey = `${p.ts}:${since}`;
    const sent = Math.max(s.remindersForStep.length, REMINDED.get(guardKey)?.count || 0);
    const lastAt = Math.max(last ? parseFloat(last.ts) * 1000 : 0, REMINDED.get(guardKey)?.at || 0);
    if (!force && lastAt && (Date.now() - lastAt) / 60000 < REMIND_EVERY_MIN) continue;
    if (!force && sent >= MAX_REMINDERS) continue;
    const n = sent + 1;
    REMINDED.set(guardKey, { count: n, at: Date.now() });
    const fyiApprovers = n >= 2 && !who.some(w => APPROVERS.some(a => w.includes(a))) ? ` _fyi ${APPROVERS.map(u => `<@${u}>`).join(' ')}_` : '';
    await client.chat.postMessage({ channel: CHANNEL, thread_ts: p.ts, unfurl_links: false,
      text: `${who.join(' ') || APPROVERS.map(u => `<@${u}>`).join(' ')} ${MARK} on you to press *${action}* — <${link(since)}|${step}> (pending since ${hhmm(since)}, ${dur(waited)}).${fyiApprovers}` }).catch(() => {});
    logger.info?.(`[Requests] Reminder ${n} for ${name}: ${step}`);
  }
  return report;
}

// ── Scheduling + on demand ───────────────────────────────────────────
function start(client) {
  setInterval(() => scan(client).catch(err => console.warn('[Requests] scan failed:', err.message)), 15 * 60 * 1000).unref?.();
  setTimeout(() => scan(client).catch(() => {}), 60 * 1000);
}

// '@QA Agent this release was cancelled' / 'cancel' / 'hủy' / 'ignore' in a request thread
function isCancelCommand(event) {
  const t = (event.text || '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, ' ');
  return event.channel === CHANNEL && !!event.thread_ts && (/\bcancel(?:led|ed)?\b|h[uủ]y|hủy|\bignore\b|\bstop\s+(?:following|tracking)\b/i.test(t));
}
async function handleCancel({ event, client }) {
  const rr = await client.conversations.replies({ channel: CHANNEL, ts: event.thread_ts, limit: 200 }).catch(() => ({ messages: [] }));
  const msgs = rr.messages || [];
  if (!/Release Request\*?\s*for platform/i.test(msgs[0]?.text || '')) return false;
  const { user_id: botUid } = await client.auth.test();
  for (const r of msgs.filter(m => m.user === botUid && isReminder(m))) await client.chat.delete({ channel: CHANNEL, ts: r.ts }).catch(() => {});
  await client.chat.postMessage({ channel: CHANNEL, thread_ts: event.thread_ts,
    text: `Stopped following this release request (${requestName(msgs[0].text)}) — cancelled by <@${event.user}>. I removed my reminders here.` });
  return true;
}

// '@QA Agent release status' (anywhere) / 'status' in a request thread
const STATUS_RE = /\b(?:release\s+(?:request\s+)?status|status|where|stuck|check)\b/i;
function isRequestStatusCommand(event) {
  const t = (event.text || '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '');
  return (event.channel === CHANNEL && STATUS_RE.test(t)) || /\brelease\s+requests?\b/i.test(t);
}
async function handleStatus({ event, client }) {
  const tTs = event.thread_ts || event.ts;
  const only = event.channel === CHANNEL && event.thread_ts ? event.thread_ts : null;
  const report = await scan(client, { force: !!only, onlyTs: only });
  if (only) return;                                           // the thread got its update from the scan
  const open = report.filter(r => r.state !== 'finished' || r.jiraReleased === false);
  const lines = open.map(r => `• <${link(r.ts)}|${r.name}> — ${r.state}${r.waited ? ` (${dur(r.waited)})` : ''}${r.blockedBy ? ` · blocked by ${r.blockedBy}` : ''}${r.state === 'finished' && r.jiraReleased === false ? ' · not marked released in Jira' : ''}`);
  await client.chat.postMessage({ channel: event.channel, thread_ts: tTs, unfurl_links: false,
    text: lines.length ? `Release requests in <#${CHANNEL}> that aren't done:\n${lines.join('\n')}` : 'Every release request from the last week is finished and marked released.' });
}

module.exports = { start, scan, readThread, stepLabel, actionOf, waitingOn, depOf, isRequestStatusCommand, handleStatus, isCancelCommand, handleCancel, whoToTag, roleOfStep };
