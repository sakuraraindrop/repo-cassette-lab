import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID, token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json';
const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const mod=t.protocol==='https:'?https:http;
  const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(c)}));});
  r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
const mk=(tag)=>Buffer.from(JSON.stringify({full_name:`x/${tag}`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:tag,stargazers_count:0}));
async function create(name,version,mime){try{return await client.CreateArtifact({...ids,name,version,...(mime!==undefined?{mimeType:StringValue.create({value:mime})}:{})});}catch(e){return {ok:false,err:String(e.message).slice(0,160)}}}
async function fin(name,body){try{return await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});}catch(e){return {ok:false,err:String(e.message).slice(0,160)}}}
async function list(){try{return await client.ListArtifacts({...ids});}catch(e){return {ok:false,err:String(e.message).slice(0,120)}}}
async function dl(id){const r1=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'caseprobe'});const e={status:r1.status};if(r1.headers.location){const u=new URL(r1.headers.location);e.rsct=u.searchParams.get('rsct');e.blob=u.pathname.split('/').pop();}return e;}
const A=mk('A'),B=mk('B');
const base=`case-${runId}`;
const cases=[
 ['v7U-v6L', `${base}-Xa`, `${base}-xA`, 7,6],
 ['v6U-v7L', `${base}-Yb`, `${base}-yB`, 6,7],
 ['v7L-v6U', `${base}-zC`, `${base}-Zc`, 7,6],
 ['v6L-v7U', `${base}-Wd`, `${base}-wD`, 6,7],
];
for(const [label,n1,n2,v1,v2] of cases){
  const rec={label,n1,n2};
  const m1=v1===7?'application/json':odd, m2=v2===7?'application/json':odd;
  const c1=await create(n1,v1,m1); rec.c1={ok:!!c1.ok,ext:c1.signedUploadUrl?new URL(c1.signedUploadUrl).pathname.split('.').pop():null,err:c1.err};
  const c2=await create(n2,v2,m2); rec.c2={ok:!!c2.ok,ext:c2.signedUploadUrl?new URL(c2.signedUploadUrl).pathname.split('.').pop():null,err:c2.err};
  if(c1.ok) await upload(c1.signedUploadUrl,A,odd);
  if(c2.ok && c2.signedUploadUrl!==c1.signedUploadUrl) await upload(c2.signedUploadUrl,B,odd);
  const f1=await fin(n1,A); rec.f1={ok:!!f1.ok,id:String(f1.artifactId||''),err:f1.err};
  const f2=await fin(n2, B); rec.f2={ok:!!f2.ok,id:String(f2.artifactId||''),err:f2.err};
  const f1b=await fin(n2,A); rec.f1b={ok:!!f1b.ok,id:String(f1b.artifactId||''),err:f1b.err};
  const l=await list(); rec.list=(l.artifacts||[]).filter(a=>a.name.toLowerCase().startsWith(base.toLowerCase())).map(a=>({id:String(a.databaseId),name:a.name}));
  rec.dls=[]; for(const e of rec.list){ if(e.id) rec.dls.push({id:e.id,...await dl(e.id)}); }
  console.log('CASE',JSON.stringify(rec));
}
