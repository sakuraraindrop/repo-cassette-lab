const artifact = require('@actions/artifact');
const {writeFileSync,mkdirSync} = require('node:fs');
(async () => {
  const dir='/tmp/legacy-files';mkdirSync(dir,{recursive:true});
  const body=JSON.stringify({probe:'legacy',run:process.env.GITHUB_RUN_ID});
  writeFileSync(`${dir}/payload.json`,body);
  const name=`legacyprobe-${process.env.GITHUB_RUN_ID}`;
  const client=artifact.create();
  const r=await client.uploadArtifact(name,[`${dir}/payload.json`],dir);
  console.log('LEGACY_UPLOAD',JSON.stringify({name,size:r.size,failed:r.failedItems}));
})().catch(e=>{console.error('LEGACY_ERR',e);process.exit(1)});
