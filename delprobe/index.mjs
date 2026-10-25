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
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function req(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);const mod=target.protocol==='https:'?https:http;
    const r=mod.request(target,{method,headers,timeout:20000},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));
    if(body)r.write(body);r.end();
  });
}
async function upload(url,bytes){await new BlobClient(url).getBlockBlobClient().uploadData(bytes,{blobHTTPHeaders:{blobContentType:odd}});}
async function create(name,version,mime){
  try{const v=await client.CreateArtifact({...ids,name,version,mimeType:StringValue.create({value:mime})});return {ok:!!v.ok,url:v.signedUploadUrl,ext:v.signedUploadUrl?new URL(v.signedUploadUrl).pathname.split('.').at(-1):null};}
  catch(e){return {ok:false,error:String(e.message||e).slice(0,180)};}
}
async function finalize(name,bytes){
  try{const v=await client.FinalizeArtifact({...ids,name,size:String(bytes.length),hash:StringValue.create({value:`sha256:${sha(bytes)}`})});return {ok:!!v.ok,id:String(v.artifactId||'')};}
  catch(e){return {ok:false,error:String(e.message||e).slice(0,180)};}
}
async function del(name){
  try{const v=await client.DeleteArtifact({...ids,name});return {ok:!!v.ok,id:String(v.artifactId||'')};}
  catch(e){return {ok:false,error:String(e.message||e).slice(0,180)};}
}
async function inspectName(name){
  try{const v=await client.GetSignedArtifactURL({...ids,name});const u=new URL(v.signedUrl);const r=await req(u.href);return {ok:r.status===200,status:r.status,rsct:u.searchParams.get('rsct'),bytes:r.body.length,bodyMatch:null};}
  catch(e){return {ok:false,error:String(e.message||e).slice(0,180)};}
}
async function inspectId(id,carrier){
  const r=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-delprobe'});
  const out={status:r.status};
  if(r.headers.location){
    const u=new URL(r.headers.location);out.rsct=u.searchParams.get('rsct');
    const f=await req(u.href);out.finalStatus=f.status;out.finalCt=f.headers['content-type']||null;out.bodyMatch=carrier?f.body.equals(carrier):null;
  }
  return out;
}
function carrierFor(id,label){
  const repository=`${repo}/actions/artifacts/${id}/zip`;
  return {repository,bytes:Buffer.from(JSON.stringify({full_name:repository,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:label,stargazers_count:0}))};
}

const placeholder=Buffer.from('{}');
async function runCase(label,firstV,firstMime,secondV,secondMime,delay=0){
  const name=`delprobe-${runId}-${label}`;
  const rec={label,name};
  const first=await create(name,firstV,firstMime);rec.first=first;
  if(first.ok){
    await upload(first.url,placeholder).catch(()=>{});
    rec.final1=await finalize(name,placeholder);
    rec.del=await del(name);
  }
  if(delay)await sleep(delay);
  const second=await create(name,secondV,secondMime);rec.second=second;
  if(!second.ok)return rec;
  await upload(second.url,placeholder).catch(()=>{});
  const fin2=await finalize(name,placeholder);rec.final2=fin2;
  rec.viewName=await inspectName(name);
  if(fin2.ok){
    const c=carrierFor(fin2.id,label);
    await upload(second.url,c.bytes).catch(()=>{});
    if(first.url)await upload(first.url,c.bytes).catch(()=>{});
    rec.carrierSha=sha(c.bytes);rec.carrierRepo=c.repository;
    rec.viewId=await inspectId(fin2.id,c.bytes);
  }
  return rec;
}

const cases=[
  ['v6odd-del-v7json',6,odd,7,'application/json',0],
  ['v7json-del-v7json',7,'application/json',7,'application/json',0],
  ['v6odd-del-v6odd',6,odd,6,odd,0],
  ['v6odd-del-wait-v7json',6,odd,7,'application/json',500],
  ['v6odd-del-wait2-v7json',6,odd,7,'application/json',3000],
  ['v7json-del-wait-v6odd',7,'application/json',6,odd,500],
];
for(const c of cases){
  const rec=await runCase(...c);
  console.log('DELPROBE',JSON.stringify(rec));
}
