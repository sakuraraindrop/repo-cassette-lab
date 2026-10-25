import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';
import {Timestamp} from '../node_modules/@actions/artifact/lib/generated/google/protobuf/timestamp.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const runId = process.env.GITHUB_RUN_ID;
const body = Buffer.from('{"expiry":"body"}');

function request(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github.v3+json', 'user-agent': 'expirytest'}}, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(c)}));
    }).on('error', reject);
  });
}

const out = [];
async function trial(label, expiresAt) {
  const rec = {label};
  const name = `expirytest-${runId}-${label}`;
  try {
    const created = await client.CreateArtifact({...ids, name, version: 7, mimeType: StringValue.create({value: 'application/json'}), expiresAt});
    rec.createOk = Boolean(created.ok);
    if (!created.ok) { out.push(rec); return; }
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body);
    const fin = await client.FinalizeArtifact({...ids, name, size: String(body.length)});
    rec.finOk = Boolean(fin.ok);
    rec.id = String(fin.artifactId || '');
    if (!fin.ok) { out.push(rec); return; }
    for (const delay of [0, 3000]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const r = await request(`https://api.github.com/repos/${repo}/actions/artifacts/${rec.id}/zip`);
      rec[`status${delay}`] = r.status;
      rec[`loc${delay}`] = (r.headers.location || '').slice(0, 200);
      rec[`body${delay}`] = r.body.toString().slice(0, 100);
      if (r.headers.location) {
        const u = new URL(r.headers.location);
        rec[`rsct${delay}`] = u.searchParams.get('rsct');
        rec[`hasApiVersion${delay}`] = u.searchParams.has('api-version');
      }
    }
  } catch (e) {
    rec.err = String(e).slice(0, 250);
  }
  out.push(rec);
}

const now = Date.now();
await trial('past', Timestamp.fromDate(new Date(now - 3600_000)));
await trial('soon', Timestamp.fromDate(new Date(now + 2000)));
await trial('future', Timestamp.fromDate(new Date(now + 86400_000)));
console.log('EXPIRY', JSON.stringify(out));
