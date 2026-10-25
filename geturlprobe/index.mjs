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
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID;
const body=Buffer.from(JSON.stringify({full_name:`${repo}/x`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'geturl',stargazers_count:0}));
const sha=b=>createHash('sha256').update(b).digest('hex');
const odd='\u0085application/json';
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const mod=t.protocol==='https:'?https:http;
  const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(c)}));});
  r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function twirpRaw(method, payloadObj){
  const url=new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, getResultsServiceUrl()).href;
  const payload=JSON.stringify(payloadObj);
  const r=await req(url,'POST',Buffer.from(payload),{Authorization:`Bearer ${getRuntimeToken()}`,'Content-Type':'application/json'});
  let j=null;try{j=JSON.parse(r.body.toString())}catch{}
  return {status:r.status,body:j,raw:r.body.toString().slice(0,200)};
}
const name=`geturl-${runId}`;
const created=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:'application/json'})});
if(!created.ok){console.log('GETURL create fail');process.exit(0);}
await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body,{blobHTTPHeaders:{blobContentType:odd}});
const fin=await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});
const id=String(fin.artifactId);
console.log('GETURL base',JSON.stringify({id,ok:fin.ok}));
const variants=[
 ['base',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name}],
 ['unknown',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name,foo:'bar'}],
 ['mime',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name,mime_type:odd}],
 ['content_type',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name,content_type:odd}],
 ['version',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name,version:7,mime_type:odd}],
 ['dbid',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name,database_id:id}],
 ['id',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name,id:id}],
 ['artifact_id',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name,artifact_id:id}],
 ['disposition',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name,disposition:'inline',extension:'json'}],
 ['nonexistent',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name:'does-not-exist-'+runId}],
 ['empty-name',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name:''}],
];
for(const [label,p] of variants){
  const rec={label};
  try{const r=await twirpRaw('GetSignedArtifactURL',p);rec.status=r.status;rec.code=r.body&&r.body.code;rec.msg=r.body&&r.body.msg;
    const url=r.body&&(r.body.signed_url||r.body.signedUrl);
    if(url){const u=new URL(url);rec.hasRsct=u.searchParams.has('rsct');rec.rsct=u.searchParams.get('rsct');rec.path=u.pathname.split('/').pop();rec.host=u.host;}
    else rec.raw=r.raw;
  }catch(e){rec.err=String(e.message).slice(0,150);}
  console.log('GETURL',JSON.stringify(rec));
}
// CreateArtifact unknown-field tolerance
const cf=await twirpRaw('CreateArtifact',{workflow_run_backend_id:ids.workflowRunBackendId,workflow_job_run_backend_id:ids.workflowJobRunBackendId,name:`geturl-unk-${runId}`,version:7,mime_type:'application/json',foo:'bar'});
console.log('GETURL create-unknown',JSON.stringify({status:cf.status,code:cf.body&&cf.body.code,ok:cf.body&&cf.body.ok,msg:cf.body&&cf.body.msg}));
