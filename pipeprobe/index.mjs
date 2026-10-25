import https from 'node:https';
import http from 'node:http';
const runtime=process.env.ACTIONS_RUNTIME_URL;
const token=process.env.ACTIONS_RUNTIME_TOKEN;
const runId=process.env.GITHUB_RUN_ID;
function req(url,method='GET',body=null,headers={}){return new Promise((resolve,reject)=>{const t=new URL(url);const m=t.protocol==='https:'?https:http;const r=m.request(t,{method,headers,timeout:15000},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(c)}));});r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));if(body)r.write(body);r.end();});}
const base=runtime.replace(/\/$/,'');
const cases=[
 ['6.0-preview-actions_storage','6.0-preview','actions_storage'],
 ['6.0-preview-ActionsStorage','6.0-preview','ActionsStorage'],
 ['5.1-preview-actions_storage','5.1-preview','actions_storage'],
 ['1.0-actions_storage','1.0','actions_storage'],
 ['6.0-preview-minimal','6.0-preview',undefined],
];
for(const [label,api,type] of cases){
  const url=`${base}/_apis/pipelines/workflows/${runId}/artifacts?api-version=${api}`;
  const payload={Name:`pipe-${runId}-${label}`};
  if(type!==undefined)payload.Type=type;
  const body=Buffer.from(JSON.stringify(payload));
  const r=await req(url,'POST',body,{Authorization:`Bearer ${token}`,Accept:`application/json;api-version=${api}`,'Content-Type':'application/json','Content-Length':String(body.length)});
  console.log('PIPE',JSON.stringify({label,status:r.status,body:r.body.toString().slice(0,300)}));
}
