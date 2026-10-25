import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID, token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json';
const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const t=new URL(url);const mod=t.protocol==='https:'?https:http;
    const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(c)}));});
    r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();
  });
}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
const mk=(tag)=>Buffer.from(JSON.stringify({full_name:`x/${tag}`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:tag,stargazers_count:0}));
async function create(name,version,mime){const r=await client.CreateArtifact({...ids,name,version,...(mime!==undefined?{mimeType:StringValue.create({value:mime})}:{})});return r;}
async function fin(name,body){const r=await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});return r;}
async function list(){const r=await client.ListArtifacts({...ids});return r;}

const bodyA=mk('A'), bodyB=mk('B');
const cases=[
 ['v6odd-then-v7json'],
 ['v7json-then-v6odd'],
 ['v6odd-then-v7json-then-finA-finB'],
 ['v6odd-fin-then-v7json'],
];
for(const [label] of cases){
  const name=`dup-${runId}-${label}`;
  const rec={label};
  try{
    let c1,c2;
    if(label.startsWith('v6odd-then-v7json')){
      c1=await create(name,6,odd); c2=await create(name,7,'application/json');
    } else if(label.startsWith('v7json-then-v6odd')){
      c1=await create(name,7,'application/json'); c2=await create(name,6,odd);
    } else if(label.startsWith('v6odd-fin')){
      c1=await create(name,6,odd);
      if(c1.ok){await upload(c1.signedUploadUrl,bodyA,odd);rec.fin1=await fin(name,bodyA);}
      c2=await create(name,7,'application/json');
    }
    rec.c1={ok:!!c1?.ok,ext:c1?.signedUploadUrl?new URL(c1.signedUploadUrl).pathname.split('.').pop():null};
    rec.c2={ok:!!c2?.ok,ext:c2?.signedUploadUrl?new URL(c2.signedUploadUrl).pathname.split('.').pop():null};
    // upload distinct bodies to both urls if present
    if(c1?.ok) await upload(c1.signedUploadUrl,bodyA,odd);
    if(c2?.ok && c2.signedUploadUrl!==c1?.signedUploadUrl) await upload(c2.signedUploadUrl,bodyB,odd);
    if(label.endsWith('finA-finB')){
      rec.finA=await fin(name,bodyA); rec.finB=await fin(name,bodyB);
    } else {
      rec.finA=await fin(name,bodyA);
      if(!rec.finA.ok) rec.finB=await fin(name,bodyB);
    }
    const l=await list();
    rec.list=(l.artifacts||[]).filter(a=>a.name===name).map(a=>({id:String(a.databaseId),size:String(a.size)}));
    // download each listed id
    rec.dl=[];
    for(const a of rec.list){
      const r1=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${a.id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'dupname'});
      const e={id:a.id,status:r1.status};
      if(r1.headers.location){const u=new URL(r1.headers.location);e.ext=u.pathname.split('.').pop();e.rsct=u.searchParams.get('rsct');}
      rec.dl.push(e);
    }
  }catch(e){rec.err=String(e.message).slice(0,300);}
  console.log('DUP',JSON.stringify(rec));
}
