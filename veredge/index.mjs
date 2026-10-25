import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {getRuntimeToken, getResultsServiceUrl} from '../node_modules/@actions/artifact/lib/internal/shared/config.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids=getBackendIdsFromToken(); const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID, token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json';
const body=Buffer.from(JSON.stringify({full_name:`${repo}/x`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'veredge',stargazers_count:0}));
const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const mod=t.protocol==='https:'?https:http;
  const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(c)}));});
  r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
async function rawCreate(name, fieldsJson){
  const url=new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', getResultsServiceUrl()).href;
  const payload=`{"workflow_run_backend_id":${JSON.stringify(ids.workflowRunBackendId)},"workflow_job_run_backend_id":${JSON.stringify(ids.workflowJobRunBackendId)},"name":${JSON.stringify(name)},${fieldsJson}}`;
  const r=await req(url,'POST',Buffer.from(payload),{Authorization:`Bearer ${getRuntimeToken()}`,'Content-Type':'application/json'});
  let j=null;try{j=JSON.parse(r.body.toString())}catch{}
  return {status:r.status,body:j};
}
const cases=[
 ['neg1-odd','-1',odd],['neg7-odd','-7',odd],['intmin-odd','-2147483648',odd],
 ['intmax-odd','2147483647',odd],['v8-odd','8',odd],['v9-odd','9',odd],['v100-odd','100',odd],
 ['neg1-json','-1','application/json'],['v8-json','8','application/json'],['intmax-json','2147483647','application/json'],
 ['str-plus7-odd','"+7"',odd],['str-space7-odd','" 7"',odd],['str-7nl-odd','"7\\n"',odd],
 ['str-0x7-odd','"0x7"',odd],['str-7.0-odd','"7.0"',odd],['float7-odd','7.0',odd],['float-odd','7.5',odd],
];
for(const [label,ver,mime] of cases){
  const name=`ve-${runId}-${label}`;
  const rec={label,ver};
  try{
    const r=await rawCreate(name,`"version":${ver},"mime_type":${JSON.stringify(mime)}`);
    rec.create=r.status; rec.code=r.body&&r.body.code; rec.msg=r.body&&r.body.msg; rec.ok=!!(r.body&&r.body.ok);
    if(r.body&&r.body.ok&&r.body.signed_upload_url){
      await upload(r.body.signed_upload_url,body,odd);
      const fin=await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});
      rec.fin=!!fin.ok;
      if(fin.ok){const id=String(fin.artifactId);
        const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'veredge'});
        rec.rest=api.status;
        if(api.headers.location){const u=new URL(api.headers.location);rec.rsct=u.searchParams.get('rsct');rec.blob=u.pathname.split('/').pop();
          const f=await req(api.headers.location);rec.finalCtHex=f.headers['content-type']?Buffer.from(f.headers['content-type'],'latin1').toString('hex'):null;}
      }
    }
  }catch(e){rec.err=String(e.message).slice(0,180);}
  console.log('VEREDGE',JSON.stringify(rec));
}
