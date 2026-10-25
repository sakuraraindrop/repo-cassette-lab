import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';
const ids=getBackendIdsFromToken();const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY,runId=process.env.GITHUB_RUN_ID,token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json';const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const m=t.protocol==='https:'?https:http;const r=m.request(t,{method,headers,timeout:20000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(c)}));});r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function upload(url,bytes,ct){await new BlobClient(url).getBlockBlobClient().uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
const cases=['wrong-hash','neg-size','zero-size','huge-size','off-by-one','matching'];
for(let i=0;i<cases.length;i++){
  const label=cases[i];const name=`mm-${runId}-${label}`;const rec={label};const placeholder=Buffer.from('{}');
  try{
    const created=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:'application/json'})});
    if(!created.ok){console.log('MM',JSON.stringify({...rec,error:'create'}));continue;}
    await upload(created.signedUploadUrl,placeholder,odd);
    let size=String(placeholder.length),hash='sha256:'+sha(placeholder);
    if(label==='wrong-hash')hash='sha256:'+sha(Buffer.from('different'));
    if(label==='neg-size')size='-5';
    if(label==='zero-size')size='0';
    if(label==='huge-size')size='999999999';
    if(label==='off-by-one')size='1';
    let fin;
    try{const v=await client.FinalizeArtifact({...ids,name,size,hash:StringValue.create({value:hash})});fin={ok:!!v.ok,id:String(v.artifactId||'')};}
    catch(e){fin={ok:false,error:String(e.message||e).slice(0,140)};}
    rec.final=fin;
    if(fin.ok){
      const carrier=Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${fin.id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:label,stargazers_count:0}));
      await upload(created.signedUploadUrl,carrier,odd);
      rec.carrierSha=sha(carrier);
      const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${fin.id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-mm'});
      rec.restStatus=api.status;
      if(api.headers.location){const u=new URL(api.headers.location);rec.rsct=u.searchParams.get('rsct');rec.rsctHex=Buffer.from(rec.rsct||'','latin1').toString('hex');const f=await req(api.headers.location);rec.finalStatus=f.status;rec.finalCtHex=Buffer.from(f.headers['content-type']||'','latin1').toString('hex');rec.bodyMatch=f.body.equals(carrier);}
    }
  }catch(e){rec.error=String(e.message||e).slice(0,140);}
  console.log('MM',JSON.stringify(rec));
}
