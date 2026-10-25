import {createHash} from 'node:crypto';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const runId = process.env.GITHUB_RUN_ID;
const sha = (b) => createHash('sha256').update(b).digest('hex');

function request(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {headers: {'user-agent': 'azurever'}}, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(c)}));
    }).on('error', reject);
  });
}
function ctHex(r) {
  for (let i = 0; i < r.rawHeaders.length; i += 2) {
    if (String(r.rawHeaders[i]).toLowerCase() === 'content-type') return Buffer.from(r.rawHeaders[i + 1], 'latin1').toString('hex');
  }
  return null;
}

const stored = [
  ['ascii', 'text/x-alpha'],
  ['nel-utf8', 'application/json\u0085'],
];
const P = Buffer.from('{"azurever":"body","x":1}');
const out = [];
for (const [label, ct] of stored) {
  const rec = {label, storedCt: ct};
  const name = `azurever-${runId}-${label}`;
  try {
    const created = await client.CreateArtifact({...ids, name, version: 7, mimeType: StringValue.create({value: 'application/json'})});
    rec.createOk = Boolean(created.ok);
    if (!created.ok) { out.push(rec); continue; }
    const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
    await blob.uploadData(P, {blobHTTPHeaders: {blobContentType: ct}});
    const fin = await client.FinalizeArtifact({...ids, name, size: String(P.length), hash: StringValue.create({value: `sha256:${sha(P)}`})});
    rec.finOk = Boolean(fin.ok);
    rec.artifactId = String(fin.artifactId || '');
    const signed = await client.GetSignedArtifactURL({...ids, name});
    const base = signed.signedUrl;
    rec.baseKeys = [...new URL(base).searchParams.keys()];
    rec.baseRsct = new URL(base).searchParams.get('rsct');
    rec.tests = [];
    const variants = [
      ['none', ''],
      ['amp2012', '&api-version=2012-02-12'],
      ['amp2013', '&api-version=2013-08-15'],
      ['amp2015', '&api-version=2015-02-21'],
      ['amp2019', '&api-version=2019-12-12'],
      ['amp2099', '&api-version=2099-01-01'],
      ['x-then-2012', '&x=1&api-version=2012-02-12'],
      ['2012-then-x', '&api-version=2012-02-12&x=1'],
      ['qm2012', '?api-version=2012-02-12'],
    ];
    for (const [vlabel, suffix] of variants) {
      try {
        const r = await request(base + suffix);
        rec.tests.push({vlabel, status: r.status, ctHex: ctHex(r), bodyMatch: r.body.equals(P)});
      } catch (e) {
        rec.tests.push({vlabel, err: String(e).slice(0, 120)});
      }
    }
  } catch (e) {
    rec.err = String(e).slice(0, 250);
  }
  out.push(rec);
}
console.log('AZUREVER', JSON.stringify(out));
