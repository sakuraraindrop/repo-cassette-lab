import {createHash} from 'node:crypto';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"krace2"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

async function create(name, version, mime) {
  try {
    const value = await client.CreateArtifact({...ids, name, version, mimeType: StringValue.create({value: mime})});
    return {ok: true, url: value.signedUploadUrl};
  } catch (e) {
    return {ok: false, err: String(e).slice(0, 100)};
  }
}
async function upload(url, bytes = placeholder) {
  if (!url) return false;
  try {
    await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {blobHTTPHeaders: {blobContentType: odd}});
    return true;
  } catch { return false; }
}
async function finalize(name) {
  try {
    const v = await client.FinalizeArtifact({...ids, name, size: String(placeholder.length), hash: StringValue.create({value: hash})});
    return {ok: true, id: String(v.artifactId)};
  } catch (e) { return {ok: false, err: String(e).slice(0, 100)}; }
}
async function del(name) {
  try { const v = await client.DeleteArtifact({...ids, name}); return {ok: Boolean(v.ok)}; }
  catch (e) { return {ok: false, err: String(e).slice(0, 100)}; }
}
function rest(id) {
  return new Promise((resolve) => {
    const r = https.request(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {
      headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github.v3+json', 'user-agent': 'krace2'},
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const loc = res.headers.location || '';
        const m = loc.match(/[?&]rsct=([^&]*)/);
        const raw = m ? m[1] : null;
        let decoded = null;
        try { decoded = raw === null ? null : new URL(loc).searchParams.get('rsct'); } catch {}
        resolve({status: res.statusCode, rawHex: raw === null ? null : Buffer.from(raw, 'latin1').toString('hex'), decoded, ext: loc.split('?')[0].split('.').pop()});
      });
    });
    r.on('error', (e) => resolve({err: String(e).slice(0, 80)}));
    r.end();
  });
}
async function inspectIds(label, idsList) {
  const out = [];
  for (const id of idsList.filter(Boolean)) {
    const r = await rest(id);
    out.push({id, ...r});
    if (r.decoded && r.decoded.includes('\u0085')) console.log(`ODD ${JSON.stringify({label, id, ...r})}`);
  }
  return out;
}

async function trial(label, fn) {
  try {
    const out = await fn();
    if (out) console.log('ROW', JSON.stringify({label, ...out}));
  } catch (e) {
    console.log('ERR', JSON.stringify({label, err: String(e).slice(0, 200)}));
  }
}

const tag = process.env.GITHUB_RUN_ID;
const jobs = [];
let seq = 0;

// 1) concurrent v6-odd + v7-json, finalize once, then finalize again; inspect both ids.
for (let i = 0; i < 12; i++) {
  const name = `k2-conc-${tag}-${i}`;
  jobs.push(() => trial(`conc-${i}`, async () => {
    const [a, b] = await Promise.all([create(name, 6, odd), create(name, 7, 'application/json')]);
    await upload(a.url); await upload(b.url);
    const f1 = await finalize(name);
    const f2 = await finalize(name);
    const ins = await inspectIds(`conc-${i}`, [f1.id, f2.id]);
    return {aOk: a.ok, bOk: b.ok, f1, f2, ins};
  }));
}

// 2) create odd v6, delete by name, create v7 json, finalize; inspect.
for (let i = 0; i < 12; i++) {
  const name = `k2-del-${tag}-${i}`;
  jobs.push(() => trial(`del-${i}`, async () => {
    const a = await create(name, 6, odd);
    await upload(a.url);
    const d = await del(name);
    const b = await create(name, 7, 'application/json');
    await upload(b.url);
    const f = await finalize(name);
    const ins = await inspectIds(`del-${i}`, [f.id]);
    return {aOk: a.ok, d, bOk: b.ok, f, ins};
  }));
}

// 3) finalize v7 json, then race delete/create odd with small delays, finalize again.
for (let i = 0; i < 12; i++) {
  const name = `k2-re-${tag}-${i}`;
  const delay = [0, 5, 15][i % 3];
  jobs.push(() => trial(`re-${i}-d${delay}`, async () => {
    const a = await create(name, 7, 'application/json');
    await upload(a.url);
    const f1 = await finalize(name);
    const p = del(name);
    await sleep(delay);
    const b = await create(name, 6, odd);
    const d = await p;
    await upload(b.url);
    const f2 = await finalize(name);
    const ins = await inspectIds(`re-${i}-d${delay}`, [f1.id, f2.id]);
    return {aOk: a.ok, f1, d, bOk: b.ok, f2, ins};
  }));
}

// 4) create/finalize odd v6, then create v7 json with same name (expected 409) and finalize.
for (let i = 0; i < 8; i++) {
  const name = `k2-v6v7-${tag}-${i}`;
  jobs.push(() => trial(`v6v7-${i}`, async () => {
    const a = await create(name, 6, odd);
    await upload(a.url);
    const f1 = await finalize(name);
    const b = await create(name, 7, 'application/json');
    await upload(b.url);
    const f2 = await finalize(name);
    const ins = await inspectIds(`v6v7-${i}`, [f1.id, f2.id]);
    return {aOk: a.ok, f1, bOk: b.ok, bErr: b.err, f2, ins};
  }));
}

for (let i = 0; i < jobs.length; i += 8) {
  await Promise.all(jobs.slice(i, i + 8).map((fn) => fn()));
}
console.log('KRACE2_DONE');
