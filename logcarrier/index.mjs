import {createHash} from 'node:crypto';

const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const ghToken = process.env.GITHUB_TOKEN;
const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
const scope = claims.scp.split(' ').find((v) => v.startsWith('Actions.Results:'));
const [, runBackend, jobBackend] = scope.split(':');
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function api(path, opts = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${ghToken}`,
      accept: 'application/vnd.github.v3+json',
      'user-agent': 'repo-cassette-logcarrier',
      'x-github-api-version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return {status: r.status, headers: r.headers, body, text};
}

async function twirp(method, payload) {
  const base = resultsUrl.endsWith('/') ? resultsUrl : `${resultsUrl}/`;
  const url = new URL(`/twirp/results.services.receiver.Receiver/${method}`, base);
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtimeToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'repo-cassette-logcarrier',
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return {status: r.status, body, text};
}

const jobs = await api(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
const active = (jobs.body?.jobs || []).filter((j) => j.status === 'in_progress');
const jobId = String(process.env.TARGET_JOB_ID || active[0]?.id || '');
if (!/^\d+$/.test(jobId)) throw new Error(`no job id: ${jobs.text.slice(0, 200)}`);

const repository = `${repo}/actions/jobs/${jobId}/logs`;
const body = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'repo cassette job log carrier',
  stargazers_count: 0,
}));

const signed = await twirp('GetJobLogsSignedBlobURL', {
  workflow_run_backend_id: runBackend,
  workflow_job_run_backend_id: jobBackend,
});
const logsUrl = signed.body?.logs_url || signed.body?.logsUrl;
const storageType = signed.body?.blob_storage_type || signed.body?.blobStorageType;
console.log('LOGCARRIER-SIGNED', JSON.stringify({signedStatus: signed.status, keys: signed.body ? Object.keys(signed.body) : null, storageType, hasUrl: Boolean(logsUrl), signedBody: signed.body ? JSON.stringify(signed.body).replace(/https:\/\/[^" ]+/g, '<URL>').slice(0, 200) : signed.text.slice(0, 200)}));
if (!logsUrl) throw new Error('no logs_url');

const create = await fetch(logsUrl, {
  method: 'PUT',
  headers: {'content-type': 'text/plain', 'x-ms-blob-type': 'AppendBlob'},
  body: Buffer.alloc(0),
});
console.log('LOGCARRIER-CREATE', create.status, (await create.text()).slice(0, 120));
const appendUrl = `${logsUrl}${logsUrl.includes('?') ? '&' : '?'}comp=appendblock&seal=true`;
const append = await fetch(appendUrl, {
  method: 'PUT',
  headers: {'x-ms-blob-sealed': 'true', 'content-length': String(body.length)},
  body,
});
console.log('LOGCARRIER-APPEND', append.status, (await append.text()).slice(0, 160));
const metadata = await twirp('CreateJobLogsMetadata', {
  workflow_run_backend_id: runBackend,
  workflow_job_run_backend_id: jobBackend,
  uploaded_at: new Date().toISOString(),
  line_count: 1,
});
console.log('LOGCARRIER-META', JSON.stringify({status: metadata.status, body: metadata.body, text: metadata.text.slice(0, 120)}));
console.log('LOGCARRIER', JSON.stringify({
  jobId,
  runId,
  runBackend,
  jobBackend,
  repository,
  bodyB64: body.toString('base64'),
  bodySha: sha(body),
  bodyLen: body.length,
}));
