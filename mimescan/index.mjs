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
const body=Buffer.from(JSON.stringify({full_name:`${repo}/x`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'mimescan',stargazers_count:0}));
const sha=b=>createHash('sha256').update(b).digest('hex');
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const mod=t.protocol==='https:'?https:http;
  const r=mod.request(t,{method,headers,timeout:25000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(c)}));});
  r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
async function upload(url,bytes,ct){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:ct}});}

const mimes=[
 'application/json','application/zip','application/octet-stream','text/plain','text/html','application/xml','text/xml',
 'application/javascript','text/javascript','application/pdf','image/png','image/jpeg','image/gif','image/webp','image/svg+xml',
 'application/gzip','application/x-gzip','application/x-tar','application/x-gtar','text/csv','text/markdown',
 'font/woff','font/woff2','font/ttf','font/otf','application/font-woff','application/vnd.ms-fontobject',
 'audio/mpeg','audio/wav','audio/ogg','video/mp4','video/webm',
 'application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
 'application/x-7z-compressed','application/x-rar-compressed','application/x-bzip2','application/x-xz','application/zstd',
 'application/vnd.github.v3+json','application/json; charset=utf-8','application/ld+json','application/problem+json',
 'Application/Json','APPLICATION/JSON','application/json\t','\tapplication/json','application/json ',' application/json',
];
for(const mime of mimes){
  const name=`ms-${runId}-${sha(Buffer.from(mime)).slice(0,10)}`;
  const rec={mime:mime.replace(/[\t\n\r]/g,'\\t'),mimeHex:Buffer.from(mime,'utf8').toString('hex')};
  try{
    const created=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:mime})});
    rec.ok=!!created.ok;
    if(!rec.ok){rec.createErr='rejected';console.log('MSCAN',JSON.stringify(rec));continue;}
    await upload(created.signedUploadUrl,body,odd);
    const fin=await client.FinalizeArtifact({...ids,name,size:String(body.length),hash:StringValue.create({value:`sha256:${sha(body)}`})});
    rec.fin=!!fin.ok;
    if(!rec.fin){console.log('MSCAN',JSON.stringify(rec));continue;}
    const id=String(fin.artifactId);
    const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'mimescan'});
    rec.rest=api.status;
    if(api.headers.location){
      const u=new URL(api.headers.location);
      rec.hasRsct=u.searchParams.has('rsct'); rec.rsct=u.searchParams.get('rsct'); rec.ext=u.pathname.split('.').pop();
      const f=await req(api.headers.location);
      rec.finalCtHex=f.headers['content-type']?Buffer.from(f.headers['content-type'],'latin1').toString('hex'):null;
      rec.ctCount=f.rawHeaders.reduce((n,v,i)=>i%2===0&&String(v).toLowerCase()==='content-type'?n+1:n,0);
    } else rec.dlBody=api.body.toString().slice(0,100);
  }catch(e){rec.err=String(e.message).slice(0,200);}
  console.log('MSCAN',JSON.stringify(rec));
}
