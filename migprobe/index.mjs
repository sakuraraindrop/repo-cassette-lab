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
const sha = (b) => createHash('sha256').update(b).digest('hex');

function req(url, method = 'GET', body = null, headers = {}) {
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
    if (body) r.write(body);
    r.end();
  });
}

async function twirpRaw(method, payloadObj) {
  const url = new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, getResultsServiceUrl()).href;
  const payload = JSON.stringify(payloadObj);
  const r = await req(url, 'POST', Buffer.from(payload), {
    Authorization: `Bearer ${getRuntimeToken()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
  let j = null;
  try { j = JSON.parse(r.body.toString()); } catch {}
  return {status: r.status, body: j, raw: r.body.toString().slice(0, 300)};
}

function typeHex(r) {
  const v = r?.headers?.['content-type'];
  return v ? Buffer.from(v, 'latin1').toString('hex') : null;
}

async function restLocation(id) {
  const r = await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, 'GET', null, {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'repo-cassette-migprobe',
  });
  const loc = r.headers.location || '';
  const u = loc ? new URL(loc) : null;
  return {
    status: r.status,
    loc: u ? {
      host: u.host,
      path: u.pathname,
      keys: [...u.searchParams.keys()].sort(),
      rsct: u.searchParams.get('rsct'),
      hasRsct: u.searchParams.has('rsct'),
      apiVersion: u.searchParams.get('api-version'),
      rscd: u.searchParams.get('rscd')?.slice(0, 120),
    } : null,
    location: loc,
  };
}

async function inspectDownload(loc) {
  if (!loc) return {};
  const cur = await req(loc);
  const curH = await req(loc, 'GET', null, {'x-ms-version': '2012-02-12'});
  return {
    plain: {status: cur.status, ctHex: typeHex(cur), body: cur.body.length, bodySha: sha(cur.body)},
    header2012: {status: curH.status, ctHex: typeHex(curH), body: curH.body.length},
  };
}

const body = Buffer.from(JSON.stringify({
  full_name: `${repo}/x`,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'migprobe',
  stargazers_count: 0,
}));

// Case 1: normal v7 artifact, direct NEL blob header, finalize, public REST.
{
  const name = `migprobe-normal-${runId}-${Date.now()}`;
  const rec = {label: 'v7-direct-nel'};
  try {
    const created = await client.CreateArtifact({...ids, name, version: 7, mimeType: StringValue.create({value: 'application/json'})});
    rec.create = Boolean(created.ok);
    if (created.ok) {
      await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body, {blobHTTPHeaders: {blobContentType: odd}});
      const fin = await client.FinalizeArtifact({...ids, name, size: String(body.length), hash: StringValue.create({value: `sha256:${sha(body)}`})});
      rec.id = String(fin.artifactId || '');
      rec.fin = Boolean(fin.ok);
      const rest = await restLocation(rec.id);
      rec.rest = rest.loc;
      rec.dl = await inspectDownload(rest.location);
      const signed = await twirpRaw('GetSignedArtifactURL', {...ids, name});
      rec.signed = signed.body ? {hasRsct: signed.body.signed_url ? new URL(signed.body.signed_url).searchParams.has('rsct') : null, rsct: signed.body.signed_url ? new URL(signed.body.signed_url).searchParams.get('rsct') : null} : signed.raw;
      if (signed.body?.signed_url) {
        const s = await req(signed.body.signed_url);
        const sOld = await req(`${signed.body.signed_url}&api-version=2012-02-12`);
        rec.signedDl = {plain: {status: s.status, ctHex: typeHex(s)}, old: {status: sOld.status, ctHex: typeHex(sOld), bodyMatch: sOld.body.equals(body)}};
      }
    }
  } catch (e) { rec.err = String(e).slice(0, 300); }
  console.log('MIGPROBE', JSON.stringify(rec));
  delete rec.location; delete rec.dl;
}

// Case 2: MigrateArtifact, then finalize migrated, inspect REST + signed URL.
for (const [label, extra] of [
  ['fresh', {}],
  ['with-size', {size: '2'}],
]) {
  const name = `migprobe-mig-${runId}-${label}-${Date.now()}`;
  const rec = {label};
  try {
    const mig = await twirpRaw('MigrateArtifact', {...ids, name, ...extra});
    rec.migrate = {status: mig.status, code: mig.body?.code, msg: mig.body?.msg, ok: mig.body?.ok, url: mig.body?.signed_upload_url ? 'yes' : (mig.body?.signed_url ? 'signed_url' : 'no')};
    const uploadUrl = mig.body?.signed_upload_url || mig.body?.signedUploadUrl;
    if (uploadUrl) {
      const up = await req(uploadUrl, 'PUT', body, {
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': odd,
        'content-length': String(body.length),
      });
      rec.upload = {status: up.status};
      const fin = await twirpRaw('FinalizeMigratedArtifact', {...ids, name, size: String(body.length)});
      rec.finalize = {status: fin.status, code: fin.body?.code, id: String(fin.body?.artifact_id ?? fin.body?.artifactId ?? '')};
      const id = rec.finalize.id;
      if (id) {
        const rest = await restLocation(id);
        rec.rest = rest.loc;
        rec.dl = await inspectDownload(rest.location);
        const signed = await twirpRaw('GetSignedArtifactURL', {...ids, name});
        if (signed.body?.signed_url) {
          const u = new URL(signed.body.signed_url);
          rec.signed = {keys: [...u.searchParams.keys()].sort(), rsct: u.searchParams.get('rsct')};
          const s = await req(signed.body.signed_url);
          const sOld = await req(`${signed.body.signed_url}&api-version=2012-02-12`);
          rec.signedDl = {plain: {status: s.status, ctHex: typeHex(s)}, old: {status: sOld.status, ctHex: typeHex(sOld), bodyMatch: sOld.body.equals(body)}};
        } else rec.signed = signed.raw;
      }
    }
  } catch (e) { rec.err = String(e).slice(0, 300); }
  console.log('MIGPROBE', JSON.stringify(rec));
}

// Case 3: migrate an existing finalized normal artifact name.
{
  const rec = {label: 'migrate-existing'};
  const name = `migprobe-existing-${runId}-${Date.now()}`;
  try {
    const created = await client.CreateArtifact({...ids, name, version: 7, mimeType: StringValue.create({value: 'application/json'})});
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body, {blobHTTPHeaders: {blobContentType: 'application/json'}});
    const fin = await client.FinalizeArtifact({...ids, name, size: String(body.length), hash: StringValue.create({value: `sha256:${sha(body)}`})});
    rec.normalId = String(fin.artifactId || '');
    const mig = await twirpRaw('MigrateArtifact', {...ids, name});
    rec.migrate = {status: mig.status, code: mig.body?.code, msg: mig.body?.msg, ok: mig.body?.ok, hasUrl: Boolean(mig.body?.signed_upload_url)};
    if (mig.body?.signed_upload_url) {
      const up = await req(mig.body.signed_upload_url, 'PUT', body, {'x-ms-blob-type': 'BlockBlob', 'content-length': String(body.length)});
      rec.upload = up.status;
      const fin2 = await twirpRaw('FinalizeMigratedArtifact', {...ids, name, size: String(body.length)});
      rec.finalize = {status: fin2.status, code: fin2.body?.code, id: String(fin2.body?.artifact_id ?? '')};
      if (rec.finalize.id) {
        const rest = await restLocation(rec.finalize.id);
        rec.rest = rest.loc;
        rec.dl = await inspectDownload(rest.location);
      }
    }
  } catch (e) { rec.err = String(e).slice(0, 300); }
  console.log('MIGPROBE', JSON.stringify(rec));
}

// Case 4: list artifacts to see migrated records.
try {
  const list = await client.ListArtifacts({...ids});
  const items = (list.artifacts || []).filter((a) => String(a.name).startsWith(`migprobe-mig-${runId}`)).map((a) => ({
    name: a.name,
    databaseId: String(a.databaseId),
    size: String(a.size),
    digest: a.digest?.value,
    createdAt: a.createdAt,
  }));
  console.log('MIGPROBE-LIST', JSON.stringify(items));
} catch (e) {
  console.log('MIGPROBE-LIST-ERR', String(e).slice(0, 200));
}
