import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {getRuntimeToken, getResultsServiceUrl} from '../node_modules/@actions/artifact/lib/internal/shared/config.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY;
const runId=process.env.GITHUB_RUN_ID;
const token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json';
const body=Buffer.from(JSON.stringify({full_name:`${repo}/x`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'mimeomit',stargazers_count:0}));
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
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}

async function rawCreate(extra, name){
  const url=new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', getResultsServiceUrl()).href;
  const payload=JSON.stringify({workflow_run_backend_id:ids.workflowRunBackendId, workflow_job_run_backend_id:ids.workflowJobRunBackendId, name, ...extra});
  const r=await req(url,'POST',Buffer.from(payload),{Authorization:`Bearer ${getRuntimeToken()}`,'Content-Type':'application/json'});
  let j=null;try{j=JSON.parse(r.body.toString())}catch{}
  return {status:r.status,body:j,raw:r.body.toString().slice(0,300)};
}

const cases=[
  ['v7-json', {version:7, mimeType:StringValue.create({value:'application/json'})}],
  ['v7-omit', {version:7}],
  ['v7-empty', {version:7, mimeType:StringValue.create({value:''})}],
  ['v7-oddtyped', {version:7, mimeType:StringValue.create({value:odd})}],
  ['v6-omit', {version:6}],
  ['v6-odd', {version:6, mimeType:StringValue.create({value:odd})}],
  ['v0-omit', {version:0}],
  ['v5-omit', {version:5}],
  ['v7-json-trail-nel', {version:7, mimeType:StringValue.create({value:'application/json\u0085'})}],
  ['v7-json-param-nel', {version:7, mimeType:StringValue.create({value:'application/json; charset=utf-8\u0085'})}],
];

for(const [label,extra] of cases){
  const name=`mimeomit-${runId}-${label}`;
  const rec={label};
  try{
    const created=await client.CreateArtifact({...ids,name,...extra});
    rec.create={ok:!!created.ok};
    if(!created.ok){console.log('MIMEO',JSON.stringify(rec));continue;}
    await upload(created.signedUploadUrl,body,odd);
    const fin=await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});
    rec.fin={ok:!!fin.ok,id:String(fin.artifactId||'')};
    const id=String(fin.artifactId);
    const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-mimeomit'});
    rec.rest=api.status;
    if(api.headers.location){
      const u=new URL(api.headers.location);
      rec.rsct=u.searchParams.get('rsct');
      rec.hasRsct=u.searchParams.has('rsct');
      rec.sv=u.searchParams.get('sv');
      rec.locHost=u.host;rec.locPath=u.pathname;
      const f=await req(api.headers.location);
      rec.finalStatus=f.status;
      rec.finalCtHex=f.headers['content-type']?Buffer.from(f.headers['content-type'],'latin1').toString('hex'):null;
      rec.finalCt=f.headers['content-type']||null;
      rec.ctCount=f.rawHeaders.reduce((n,v,i)=>i%2===0&&String(v).toLowerCase()==='content-type'?n+1:n,0);
    } else { rec.body=api.body.toString().slice(0,200); }
    // list artifacts record
    const list=await client.ListArtifacts({...ids});
    if(list.ok){const a=(list.artifacts||[]).find(x=>x.name===name);rec.list=a?{databaseId:String(a.databaseId),size:String(a.size),digest:a.digest?.value}:null;}
  }catch(e){rec.err=String(e.message).slice(0,300);}
  console.log('MIMEO',JSON.stringify(rec));
}

// raw JSON variants against CreateArtifact
const rawCases=[
  ['raw-obj', {version:7, mime_type:{value:'application/json'}}],
  ['raw-obj-odd', {version:7, mime_type:{value:odd}}],
  ['raw-array', {version:7, mime_type:['application/json']}],
  ['raw-num', {version:7, mime_type:1}],
  ['raw-null', {version:7, mime_type:null}],
  ['raw-bool', {version:7, mime_type:true}],
  ['raw-dup', {version:7, mime_type:'application/zip', mime_type:'application/json'}],
  ['raw-dup-odd', {version:7, mime_type:'application/json', mime_type:odd}],
  ['raw-nel-esc', {version:7, mime_type:'\u0085application/json'}],
  ['raw-trail', {version:7, mime_type:'application/json\u0085'}],
];
for(const [label,extra] of rawCases){
  const name=`mimeomit-raw-${runId}-${label}`;
  let rec={label};
  try{
    const r=await rawCreate(extra,name);
    rec.status=r.status;rec.body=r.body;rec.raw=r.raw;
    if(r.status===200&&r.body&&r.body.ok&&r.body.signed_upload_url){
      await upload(r.body.signed_upload_url,body,odd);
      const fin=await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});
      if(fin.ok){
        const id=String(fin.artifactId);
        rec.id=id;
        const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-mimeomit'});
        rec.rest=api.status;
        if(api.headers.location){
          const u=new URL(api.headers.location);rec.rsct=u.searchParams.get('rsct');rec.hasRsct=u.searchParams.has('rsct');
          const f=await req(api.headers.location);rec.finalStatus=f.status;
          rec.finalCtHex=f.headers['content-type']?Buffer.from(f.headers['content-type'],'latin1').toString('hex'):null;
          rec.ctCount=f.rawHeaders.reduce((n,v,i)=>i%2===0&&String(v).toLowerCase()==='content-type'?n+1:n,0);
        } else rec.dlBody=api.body.toString().slice(0,200);
      } else rec.fin=fin;
    }
  }catch(e){rec.err=String(e.message).slice(0,300);}
  console.log('MIMEORAW',JSON.stringify(rec));
}
