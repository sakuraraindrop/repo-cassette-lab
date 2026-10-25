import {DefaultArtifactClient} from '@actions/artifact';
import {writeFileSync,mkdirSync} from 'node:fs';
const dir='/tmp/legacy-files';mkdirSync(dir,{recursive:true});
const body=JSON.stringify({probe:'legacy',run:process.env.GITHUB_RUN_ID});
writeFileSync(`${dir}/payload.json`,body);
const name=`legacyprobe-${process.env.GITHUB_RUN_ID}`;
const client=DefaultArtifactClient.create();
const r=await client.uploadArtifact(name,[`${dir}/payload.json`],dir);
console.log('LEGACY_UPLOAD',JSON.stringify({name,size:r.size,failed:r.failedItems}));
