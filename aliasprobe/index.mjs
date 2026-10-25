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
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID, token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json';
const body=Buffer.from(JSON.stringify({full_name:`${repo}/x`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'alias',stargazers_count:0}));
const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{const t=new URL(url);const mod=t.protocol==='https:'?https:http;
    const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(c)}));});
    r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});
}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
async function rawCreate(name, fieldsJson){
  const url=new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', getResultsServiceUrl()).href;
  const payload=`{"workflow_run_backend_id":${JSON.stringify(ids.workflowRunBackendId)},"workflow_job_run_backend_id":${JSON.stringify(ids.workflowJobRunBackendId)},"name":${JSON.stringify(name)},${fieldsJson}}`;
  const r=await req(url,'POST',Buffer.from(payload),{Authorization:`Bearer ${getRuntimeToken()}`,'Content-Type':'application/json'});
  let j=null;try{j=JSON.parse(r.body.toString())}catch{}
  return {status:r.status,body:j,raw:r.body.toString().slice(0,200),payload};
}
const O=JSON.stringify(odd);
const J=JSON.stringify('application/json');
const cases=[
 ['alias-valid', `"version":7,"mimeType":${J}`],
 ['alias-odd', `"version":7,"mimeType":${O}`],
 ['alias-odd-then-snake', `"version":7,"mimeType":${O},"mime_type":${J}`],
 ['snake-odd-then-alias', `"version":7,"mime_type":${O},"mimeType":${J}`],
 ['snake-json-then-alias-odd', `"version":7,"mime_type":${J},"mimeType":${O}`],
 ['dup-version-6-7-odd', `"version":6,"version":7,"mime_type":${O}`],
 ['dup-version-7-6-odd', `"version":7,"version":6,"mime_type":${O}`],
 ['dup-version-6-7-json', `"version":6,"version":7,"mime_type":${J}`],
 ['scREAMING', `"version":7,"MIME_TYPE":${J}`],
 ['camel-case-weird', `"version":7,"Mime_Type":${J}`],
 ['space-key', `"version":7,"mime_type ":${J}`],
 ['dup-snake-json-odd', `"version":7,"mime_type":${J},"mime_type":${O}`],
 ['dup-snake-odd-json', `"version":7,"mime_type":${O},"mime_type":${J}`],
 ['version-string-7', `"version":"7","mime_type":${J}`],
 ['mime-null-alias', `"version":7,"mimeType":null`],
];
for(const [label,fields] of cases){
  const name=`alias-${runId}-${label}`;
  const rec={label};
  try{
    const r=await rawCreate(name,fields);
    rec.status=r.status; rec.code=r.body&&r.body.code; rec.msg=r.body&&r.body.msg; rec.ok=!!(r.body&&r.body.ok);
    if(r.body&&r.body.ok&&r.body.signed_upload_url){
      await upload(r.body.signed_upload_url,body,odd);
      const fin=await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});
      rec.fin=!!fin.ok;
      if(fin.ok){
        const id=String(fin.artifactId);rec.id=id;
        const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'alias'});
        rec.rest=api.status;
        if(api.headers.location){const u=new URL(api.headers.location);rec.rsct=u.searchParams.get('rsct');rec.ext=u.pathname.split('.').pop();
          const f=await req(api.headers.location);rec.finalCtHex=f.headers['content-type']?Buffer.from(f.headers['content-type'],'latin1').toString('hex'):null;}
      }
    }
  }catch(e){rec.err=String(e.message).slice(0,200);}
  console.log('ALIAS',JSON.stringify(rec));
}
