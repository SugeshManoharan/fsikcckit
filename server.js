/* Kerala Commerce Career Connection Kit — backend.
   Zero dependencies (Node 18+). Serves the kit, stores enquiries (leads) and anonymous
   level analytics, forwards each lead to an optional CRM webhook, and serves a
   password-protected admin view. Config comes from environment variables or a .env file. */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/* ---------- config ---------- */
loadDotEnv(path.join(__dirname, '.env'));
const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// On Vercel the deployment is read-only; only /tmp is writable (and it is wiped between cold starts).
const ON_VERCEL = !!process.env.VERCEL;
const DATA_DIR = path.resolve(process.env.DATA_DIR || (ON_VERCEL ? '/tmp/kccc-data' : path.join(__dirname, 'data')));
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || '';
const CRM_WEBHOOK_SECRET = process.env.CRM_WEBHOOK_SECRET || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || ON_VERCEL;
// Origins allowed to call the public API cross-origin (e.g. where the standalone HTML is hosted). Comma-separated, or *.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const NOTICE_VERSION = '2026-11-v1';

const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_HTML = path.join(__dirname, 'admin', 'admin.html');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('Cannot create DATA_DIR ' + DATA_DIR, e.message); }

function loadDotEnv(file) {
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  txt.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) return;
    let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}

/* ---------- storage ---------- */
let leads = [];
try { leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); if (!Array.isArray(leads)) leads = []; } catch (e) { leads = []; }
let writing = Promise.resolve();
function saveLeads() {   // serialised atomic write: tmp file + rename
  writing = writing.then(async () => {
    const tmp = LEADS_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(leads, null, 1));
    await fsp.rename(tmp, LEADS_FILE);
  }).catch(e => console.error('saveLeads failed', e));
  return writing;
}
function appendEvent(ev) { return fsp.appendFile(EVENTS_FILE, JSON.stringify(ev) + '\n').catch(e => console.error('appendEvent failed', e)); }
async function readEvents() {
  let txt; try { txt = await fsp.readFile(EVENTS_FILE, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of txt.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch (e) { } }
  return out;
}

/* ---------- helpers ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
function send(res, code, body, type, extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length }, SEC_HEADERS, extra || {}));
  res.end(buf);
}
const json = (res, code, obj, extra) => send(res, code, obj, 'application/json; charset=utf-8', Object.assign({ 'Cache-Control': 'no-store' }, extra || {}));

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  try { return JSON.parse(raw || '{}'); } catch (e) { throw Object.assign(new Error('bad json'), { code: 400 }); }
}
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}
const hits = new Map();
function limited(key, max, windowMs) {   // fixed-window rate limit, in memory
  const now = Date.now(); let h = hits.get(key);
  if (!h || now - h.t > windowMs) { h = { t: now, n: 0 }; hits.set(key, h); }
  return ++h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 3600e3) hits.delete(k); }, 600e3).unref();

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const oneOf = (v, list, dflt) => list.indexOf(v) > -1 ? v : dflt;

/* ---------- leads ---------- */
const TOPICS = ['Accounting', 'Finance', 'Management', 'Taxation', 'Professional Qualification', 'Other / Not sure'];
const ASKS = ['Career guidance', 'Training options'];
const STATUSES = ['new', 'contacted', 'enrolled', 'closed'];

function cleanLead(b) {
  const p = b.profile || {}, c = b.contact || {}, r = b.results || {};
  const name = str(c.name || p.name, 100), phone = str(c.phone, 30), digits = phone.replace(/\D/g, '');
  const errors = [];
  if (!name) errors.push('name');
  if (digits.length < 10 || digits.length > 15) errors.push('phone');
  if (b.consent !== true) errors.push('consent');
  if (errors.length) return { errors };
  return {
    lead: {
      id: crypto.randomUUID(),
      ref: 'KC-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      createdAt: new Date().toISOString(),
      status: 'new',
      note: '',
      profile: { name, college: str(p.college, 150), course: str(p.course, 20), year: str(p.year, 10), district: str(p.district, 40), mindset: str(p.mind || p.mindset, 120) },
      contact: { name, phone, topic: oneOf(c.topic, TOPICS, 'Other / Not sure'), ask: oneOf(c.ask, ASKS, 'Career guidance') },
      results: {
        suggestedAreas: (Array.isArray(r.suggestedAreas) ? r.suggestedAreas : []).slice(0, 3).map(x => str(x, 60)),
        preferredPath: str(r.preferredPath, 80), exploredArea: str(r.exploredArea, 80),
        compareAreas: (Array.isArray(r.compareAreas) ? r.compareAreas : []).slice(0, 2).map(x => str(x, 60)),
        concernTip: str(r.concernTip, 200), aiSummary: str(r.aiSummary, 1200)
      },
      answers: (Array.isArray(b.answers) ? b.answers : []).slice(0, 40).map(a => ({ level: str(a && a.level, 10), q: str(a && a.q, 200), a: str(a && a.a, 400) })),
      summary: str(b.summary, 3000),
      consent: { given: true, noticeVersion: str(b.noticeVersion, 30) || NOTICE_VERSION, at: new Date().toISOString() },
      vid: str(b.vid, 40),
      crm: { status: CRM_WEBHOOK_URL ? 'pending' : 'not-configured' }
    }
  };
}
function whatsappUrl(lead) {
  if (!WHATSAPP_NUMBER) return null;
  const t = 'Hello Finishing School India, I submitted an enquiry from the Kerala Commerce Career Connection Kit (ref ' + lead.ref + ').\n' +
    'Name: ' + lead.contact.name + '\nCareer area of interest: ' + lead.contact.topic + '\nI would like to know about: ' + lead.contact.ask;
  return 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(t);
}
async function forwardToCrm(lead) {
  // Awaited by the caller before responding: on Vercel's serverless runtime, work
  // fired off after the response is sent can be frozen before it completes, so a
  // fire-and-forget call here was silently failing. Kept to one short attempt so
  // this can't blow past the platform's function-duration limit.
  if (!CRM_WEBHOOK_URL) return;
  const body = JSON.stringify({ event: 'lead.created', lead: Object.assign({}, lead, { crm: undefined }) });
  const headers = { 'Content-Type': 'application/json' };
  if (CRM_WEBHOOK_SECRET) headers['X-KCCC-Signature'] = 'sha256=' + crypto.createHmac('sha256', CRM_WEBHOOK_SECRET).update(body).digest('hex');
  try {
    const r = await fetch(CRM_WEBHOOK_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(6000) });
    lead.crm = r.ok ? { status: 'sent', at: new Date().toISOString() } : { status: 'failed', code: r.status, at: new Date().toISOString() };
  } catch (e) {
    lead.crm = { status: 'failed', error: String(e.message || e).slice(0, 200), at: new Date().toISOString() };
  }
}

/* ---------- analytics ---------- */
const EVENT_TYPES = ['visit', 'open', 'complete', 'enquiry'];
async function analytics(days) {
  const since = days ? Date.now() - days * 864e5 : 0;
  const evs = (await readEvents()).filter(e => !since || Date.parse(e.t) >= since);
  const visitors = new Set(), opened = {}, completed = {}, enquired = new Set();
  for (let n = 1; n <= 7; n++) { opened[n] = new Set(); completed[n] = new Set(); }
  for (const e of evs) {
    visitors.add(e.vid);
    if (e.type === 'open' && opened[e.level]) opened[e.level].add(e.vid);
    if (e.type === 'complete' && completed[e.level]) completed[e.level].add(e.vid);
    if (e.type === 'enquiry') enquired.add(e.vid);
  }
  const levels = [];
  for (let n = 1; n <= 7; n++) {
    const o = opened[n].size, c = completed[n].size;
    levels.push({ level: n, opened: o, completed: c, dropOff: o ? Math.max(0, Math.round((1 - c / o) * 1000) / 10) : null });
  }
  const leadCount = leads.filter(l => !since || Date.parse(l.createdAt) >= since).length;
  return { days: days || null, visitors: visitors.size, enquiries: leadCount, enquiryVisitors: enquired.size, levels };
}

/* ---------- admin auth ---------- */
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const m = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  const eq = (a, b) => { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };
  return eq(u, ADMIN_USER) & eq(rest.join(':'), ADMIN_PASSWORD) ? true : false;
}
function needAuth(res) {
  if (!ADMIN_PASSWORD) return send(res, 503, 'Admin view is disabled. Set ADMIN_PASSWORD in .env and restart the server.', 'text/plain; charset=utf-8');
  send(res, 401, 'Authentication required', 'text/plain; charset=utf-8', { 'WWW-Authenticate': 'Basic realm="KCCC admin", charset="UTF-8"' });
}
function csvCell(v) { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function leadsCsv() {
  const cols = [['Ref', l => l.ref], ['Created', l => l.createdAt], ['Status', l => l.status], ['Name', l => l.contact.name], ['Phone', l => l.contact.phone],
    ['Topic', l => l.contact.topic], ['Wants to know', l => l.contact.ask], ['College', l => l.profile.college], ['Course', l => l.profile.course],
    ['Year', l => l.profile.year], ['District', l => l.profile.district], ['Mindset', l => l.profile.mindset],
    ['Suggested areas', l => l.results.suggestedAreas.join(' · ')], ['Preferred pathway', l => l.results.preferredPath],
    ['Area explored', l => l.results.exploredArea], ['Note', l => l.note], ['CRM', l => l.crm && l.crm.status]];
  return '﻿' + [cols.map(c => c[0]).join(',')].concat(leads.slice().reverse().map(l => cols.map(c => csvCell(c[1](l))).join(','))).join('\r\n');
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
async function serveFile(res, file, cache) {
  try {
    const buf = await fsp.readFile(file);
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': cache || 'no-cache' });
  } catch (e) { send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
}

/* ---------- router ---------- */
async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, method = req.method;
  try {
    if (p === '/api/leads' || p === '/api/events' || p === '/api/config') {
      const origin = req.headers.origin;
      if (origin && (ALLOWED_ORIGINS.indexOf('*') > -1 || ALLOWED_ORIGINS.indexOf(origin) > -1)) {
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
        if (method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
          return res.end();
        }
      }
    }
    if (p === '/api/health') return json(res, 200, { ok: true });
    if (p === '/api/config' && method === 'GET') return json(res, 200, { whatsapp: !!WHATSAPP_NUMBER, noticeVersion: NOTICE_VERSION });

    if (p === '/api/leads' && method === 'POST') {
      if (limited('lead:' + clientIp(req), 10, 3600e3)) return json(res, 429, { error: 'Too many enquiries from this connection. Please try again later.' });
      const b = await readJson(req, 64 * 1024);
      if (b.website) return json(res, 200, { ok: true, ref: 'KC-000000' });   // honeypot: bots fill hidden fields
      const { lead, errors } = cleanLead(b);
      if (errors) return json(res, 422, { error: 'Please check: ' + errors.join(', '), fields: errors });
      leads.push(lead); await saveLeads();
      appendEvent({ t: lead.createdAt, vid: lead.vid || ('lead:' + lead.id), type: 'enquiry' });
      await forwardToCrm(lead); await saveLeads();
      return json(res, 201, { ok: true, ref: lead.ref, whatsappUrl: whatsappUrl(lead) });
    }

    if (p === '/api/events' && method === 'POST') {
      if (limited('ev:' + clientIp(req), 1200, 3600e3)) return json(res, 429, { error: 'rate limited' });
      const b = await readJson(req, 4 * 1024);
      const list = Array.isArray(b.events) ? b.events.slice(0, 20) : [b];
      const vid = str(b.vid, 40);
      if (!/^[A-Za-z0-9-]{8,40}$/.test(vid)) return json(res, 400, { error: 'bad vid' });
      for (const e of list) {
        const type = oneOf(e && e.type, EVENT_TYPES, null), level = +(e && e.level) || 0;
        if (!type || type === 'enquiry') continue;   // enquiries are recorded server-side only
        if ((type === 'open' || type === 'complete') && !(level >= 1 && level <= 7)) continue;
        appendEvent({ t: new Date().toISOString(), vid, type, level: level || undefined });
      }
      return json(res, 202, { ok: true });
    }

    if (p === '/admin' || p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return needAuth(res);
      if (p === '/admin') return serveFile(res, ADMIN_HTML, 'no-store');
      if (p === '/api/admin/leads' && method === 'GET') return json(res, 200, { leads: leads.slice().reverse(), statuses: STATUSES });
      if (p === '/api/admin/leads.csv' && method === 'GET') return send(res, 200, leadsCsv(), 'text/csv; charset=utf-8', { 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="kccc-leads-' + new Date().toISOString().slice(0, 10) + '.csv"' });
      if (p === '/api/admin/analytics' && method === 'GET') return json(res, 200, await analytics(+url.searchParams.get('days') || 0));
      const m = p.match(/^\/api\/admin\/leads\/([0-9a-f-]{36})$/);
      if (m && method === 'PATCH') {
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON required' });
        const lead = leads.find(l => l.id === m[1]); if (!lead) return json(res, 404, { error: 'not found' });
        const b = await readJson(req, 8 * 1024);
        if (b.status !== undefined) lead.status = oneOf(b.status, STATUSES, lead.status);
        if (b.note !== undefined) lead.note = str(b.note, 1000);
        await saveLeads(); return json(res, 200, { ok: true, lead });
      }
      if (m && method === 'DELETE') {   // for data-erasure requests from students
        const i = leads.findIndex(l => l.id === m[1]); if (i < 0) return json(res, 404, { error: 'not found' });
        leads.splice(i, 1); await saveLeads(); return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    }

    if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    let rel = decodeURIComponent(p); if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return serveFile(res, file, rel.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache');
  } catch (e) {
    const code = e.code === 413 || e.code === 400 ? e.code : 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) json(res, code, { error: code === 413 ? 'Request too large' : code === 400 ? 'Invalid request' : 'Server error' });
  }
}
const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('KCCC running on http://localhost:' + PORT + '  (admin: /admin' + (ADMIN_PASSWORD ? '' : ' — disabled until ADMIN_PASSWORD is set') + ')');
    if (!WHATSAPP_NUMBER) console.log('WHATSAPP_NUMBER not set: the WhatsApp button is hidden.');
    if (!CRM_WEBHOOK_URL) console.log('CRM_WEBHOOK_URL not set: leads are stored locally only.');
  });
}
module.exports = handler;   // Vercel calls this as a (req, res) function
module.exports.server = server;
