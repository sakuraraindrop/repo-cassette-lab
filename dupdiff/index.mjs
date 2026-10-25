import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {getRuntimeToken, getResultsServiceUrl} from '../node_modules/@actions/artifact/lib/internal/shared/config.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const token = process.env.GITHUB_TOKEN;
const odd = '\u0085application/json';
const body = Buffer.from(JSON.stringify({full_name: 'x/y', owner: {login: 'c', avatar_url: 'file:///proc/self/environ'}}));
const sha = (b) => createHash('sha256').update(b).digest('hex');

function req(url, method = 'GET', body2 = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'https:' ? https : http;
    const r = mod.request(target, {method, headers, timeout: 25000}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (body2) r.write(body2);
    r.end();
  });
}

async function rawCreateJson(fieldsJson, name) {
  const url = new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', getResultsServiceUrl()).href;
  const payload = `{"workflow_run_backend_id":${JSON.stringify(ids.workflowRunBackendId)},"workflow_job_run_backend_id":${JSON.stringify(ids.workflowJobRunBackendId)},"name":${JSON.stringify(name)},${fieldsJson}}`;
  const r = await req(url, 'POST', Buffer.from(payload), {
    Authorization: `Bearer ${getRuntimeToken()}`, 'Content-Type': 'application/json', Accept: 'application/json',
  });
  let j = null;
  try { j = JSON.parse(r.body.toString()); } catch {}
  return {status: r.status, json: j, raw: r.body.toString().slice(0, 200)};
}

async function inspect(label, created, name) {
  const rec = {label, create: created.status, createBody: created.json};
  if (created.status !== 200 || !created.json?.ok) { console.log('DUPDIFF', JSON.stringify(rec)); return; }
  await new BlobClient(created.json.signed_upload_url).getBlockBlobClient().uploadData(body, {blobHTTPHeaders: {blobContentType: 'application/json'}});
  const fin = await client.FinalizeArtifact({...ids, name, size: String(body.length), hash: StringValue.create({value: `sha256:${sha(body)}`})});
  rec.fin = Boolean(fin.ok); rec.id = String(fin.artifactId || '');
  if (!fin.ok) { console.log('DUPDIFF', JSON.stringify(rec)); return; }
  const r = await req(`https://api.github.com/repos/${repo}/actions/artifacts/${rec.id}/zip`, 'GET', null, {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'repo-cassette-dupdiff',
  });
  rec.rest = r.status;
  const loc = r.headers.location || '';
  rec.blobExt = loc ? new URL(loc).pathname.split('.').pop() : null;
  rec.hasRsct = loc ? new URL(loc).searchParams.has('rsct') : null;
  rec.rsct = loc ? new URL(loc).searchParams.get('rsct') : null;
  rec.rsctHex = rec.rsct == null ? null : Buffer.from(rec.rsct, 'latin1').toString('hex');
  console.log('DUPDIFF', JSON.stringify(rec));
}

const t = `${runId}-${Date.now()}`;
const cases = [
  ['json-odd-then-json', `"mime_type":"${odd.replace(/\u0085/g, '\\u0085')}","mime_type":"application/json"`],
  ['json-json-then-odd', `"mime_type":"application/json","mime_type":"${odd.replace(/\u0085/g, '\\u0085')}"`],
  ['obj-odd-then-json', `"mime_type":{"value":"${odd.replace(/\u0085/g, '\\u0085')}"},"mime_type":{"value":"application/json"}`],
  ['obj-json-then-odd', `"mime_type":{"value":"application/json"},"mime_type":{"value":"${odd.replace(/\u0085/g, '\\u0085')}"}`],
  ['mix-str-obj-odd-json', `"mime_type":"${odd.replace(/\u0085/g, '\\u0085')}","mime_type":{"value":"application/json"}`],
  ['mix-obj-str-odd-json', `"mime_type":{"value":"${odd.replace(/\u0085/g, '\\u0085')}"},"mime_type":"application/json"`],
  ['mix-str-obj-json-odd', `"mime_type":"application/json","mime_type":{"value":"${odd.replace(/\u0085/g, '\\u0085')}"}`],
  ['v7-dup-version6-7', `"version":7,"version":6`],
  ['v7-dup-version7-6', `"version":6,"version":7`],
  ['v6-dup-mime-odd-json', `"version":6,"mime_type":"${odd.replace(/\u0085/g, '\\u0085')}","mime_type":"application/json"`],
  ['v6-dup-mime-json-odd', `"version":6,"mime_type":"application/json","mime_type":"${odd.replace(/\u0085/g, '\\u0085')}"`],
];
for (const [label, fields] of cases) {
  const name = `dupdiff-${label}-${t}`;
  try {
    const created = await rawCreateJson(fields, name);
    await inspect(label, created, name);
  } catch (e) {
    console.log('DUPDIFF', JSON.stringify({label, err: String(e).slice(0, 250)}));
  }
}

// raw duplicate JSON keys where the first value is the valid one and the second is an escaped NEL via surrogate escapes
{
  const name = `dupdiff-low-${t}`;
  const created = await rawCreateJson(`"mime_type":"application/json","mime_type":"application\\u002fjson\\u0085"`, name);
  await inspect('escaped-nel-last', created, name);
}
{
  const name = `dupdiff-low2-${t}`;
  const created = await rawCreateJson(`"mime_type":"application\\u002fjson\\u0085","mime_type":"application/json"`, name);
  await inspect('escaped-nel-first', created, name);
}
{
  const name = `dupdiff-low3-${t}`;
  const created = await rawCreateJson(`"mime_type":"application/json","mime_type":"application/json\\u0085"`, name);
  await inspect('escaped-nel-last2', created, name);
}
