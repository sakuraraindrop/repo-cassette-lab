const t=process.env.ACTIONS_RUNTIME_TOKEN||'';
let claims={};
try{claims=JSON.parse(Buffer.from(t.split('.')[1],'base64url').toString());}catch(e){claims={err:String(e)};}
const out={
  scp:claims.scp||null,
  aud:claims.aud||null,
  iss:claims.iss||null,
  envs:{},
};
for(const [k,v] of Object.entries(process.env)){
  if(/^(ACTIONS_|GITHUB_|RUNNER_)/.test(k)){
    if(/TOKEN|SECRET|PASSWORD/i.test(k)) out.envs[k]='<redacted len='+String(v).length+'>';
    else if(/URL|ENDPOINT/i.test(k)){try{const u=new URL(v);out.envs[k]=u.origin;}catch{out.envs[k]=String(v).slice(0,120);}}
    else out.envs[k]=String(v).slice(0,120);
  }
}
console.log('ENVPROBE',JSON.stringify(out));
