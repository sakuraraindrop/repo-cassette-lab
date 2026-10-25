import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const runId = process.env.GITHUB_RUN_ID;
const body = Buffer.from('{"rsctdrop":"body"}');

function request(url, method = 'GET', payload = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request(u, {method, headers, timeout: 25000}, (res) => {
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

const names = [
  ['plain', `rsctdrop-${runId}-plain`],
  ['trail-backslash', `rsctdrop-${runId}-trail\\`],
  ['inner-backslash', `rsctdrop-${runId}-in\\ner`],
  ['semicolon', `rsctdrop-${runId}-semi;token`],
  ['percent-crlf', `rsctdrop-${runId}-pct%0d%0aX-Inject:1`],
  ['nel', `rsctdrop-${runId}-nel\u0085tail`],
  ['u2028', `rsctdrop-${runId}-u2028 tail`],
  ['emoji', `rsctdrop-${runId}-emoji\u{1F600}tail`],
  ['trail-quote', `rsctdrop-${runId}-quote"`],
  ['trail-nul', `rsctdrop-${runId}-nul\0`],
];
const out = [];
for (const [label, name] of names) {
  const rec = {label, nameB64: Buffer.from(name, 'utf8').toString('base64')};
  try {
    const created = await client.CreateArtifact({...ids, name, version: 7, mimeType: StringValue.create({value: 'application/octet-stream'})});
    rec.createOk = Boolean(created.ok);
    if (!created.ok) { out.push(rec); continue; }
    rec.uploadFile = new URL(created.signedUploadUrl).pathname.split('/').pop();
    const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
    await blob.uploadData(body, {blobHTTPHeaders: {blobContentType: 'text/x-stored'}});
    const fin = await client.FinalizeArtifact({...ids, name, size: String(body.length)});
    rec.finOk = Boolean(fin.ok);
    rec.artifactId = String(fin.artifactId || '');
    if (!fin.ok) { out.push(rec); continue; }
    const first = await request(`https://api.github.com/repos/${repo}/actions/artifacts/${rec.artifactId}/zip`, 'GET', null, {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github.v3+json', 'user-agent': 'rsctdrop',
    });
    rec.restStatus = first.status;
    const loc = first.headers.location || '';
    rec.location = loc.slice(0, 400);
    if (loc) {
      const u = new URL(loc);
      rec.rsct = u.searchParams.get('rsct');
      rec.rscd = u.searchParams.get('rscd');
      rec.hasApiVersion = u.searchParams.has('api-version');
      const asIs = await request(loc, 'GET', null, {'user-agent': 'rsctdrop'});
      rec.asIsStatus = asIs.status;
      rec.asIsCtHex = ctHex(asIs);
      rec.asIsBodyMatch = asIs.body.equals(body);
      const old = await request(loc + '&api-version=2012-02-12', 'GET', null, {'user-agent': 'rsctdrop'});
      rec.oldStatus = old.status;
      rec.oldCtHex = ctHex(old);
      rec.oldBodyMatch = old.body.equals(body);
    }
  } catch (e) {
    rec.err = String(e).slice(0, 250);
  }
  out.push(rec);
}
console.log('RSCTDROP', JSON.stringify(out));
