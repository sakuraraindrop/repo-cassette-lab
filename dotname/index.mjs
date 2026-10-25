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
const body=Buffer.from(JSON.stringify({full_name:`${repo}/x`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'dotname',stargazers_count:0}));
const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const mod=t.protocol==='https:'?https:http;
  const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(c)}));});
  r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}
const cases=[
 ['json-name-zzz','dot-'+runId+'-a.zzz','application/json'],
 ['json-name-json','dot-'+runId+'-b.json','application/json'],
 ['plain-name-json','dot-'+runId+'-c.json','text/plain'],
 ['json-name-nodot','dot-'+runId+'-d','application/json'],
 ['json-name-traildot','dot-'+runId+'-e.','application/json'],
 ['json-name-dotdot','dot-'+runId+'-f..','application/json'],
 ['json-name-%85','dot-'+runId+'-g%85','application/json'],
 ['json-name-dot85','dot-'+runId+'-h.'+String.fromCharCode(0x85)+'application/json','application/json'],
];
for(const [label,name,mime] of cases){
  const rec={label,nameHex:Buffer.from(name,'utf8').toString('hex'),mime};
  try{
    const c=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:mime})});
    rec.ok=!!c.ok; if(!c.ok){console.log('DOTNAME',JSON.stringify(rec));continue;}
    rec.uploadBlob=new URL(c.signedUploadUrl).pathname.split('/').pop();
    await upload(c.signedUploadUrl,body,odd);
    const f=await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});
    rec.fin=!!f.ok;
    if(f.ok){
      const id=String(f.artifactId);
      const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'dotname'});
      rec.rest=api.status;
      if(api.headers.location){const u=new URL(api.headers.location);rec.hasRsct=u.searchParams.has('rsct');rec.rsct=u.searchParams.get('rsct');rec.blob=u.pathname.split('/').pop();
        const fr=await req(api.headers.location);rec.finalCtHex=fr.headers['content-type']?Buffer.from(fr.headers['content-type'],'latin1').toString('hex'):null;}
    }
  }catch(e){rec.err=String(e.message).slice(0,160);}
  console.log('DOTNAME',JSON.stringify(rec));
}
