import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Session } from 'node:inspector/promises';
import { SessionManager } from '/workspace/pi-251/packages/coding-agent/dist/index.js';
const expected=await SessionManager.listAll();
let journalStreams=0;
const original=fs.createReadStream;
fs.createReadStream=(...args)=>{if(String(args[0]).endsWith('.jsonl')) journalStreams++; return original(...args);};
syncBuiltinESMExports();
const session=new Session(); session.connect();
await session.post('Profiler.enable'); await session.post('Profiler.start');
let total=0;
for(let i=0;i<100;i++) { const result=await SessionManager.listAll(); assert.equal(result.length,64); total+=result.reduce((n,s)=>n+s.messageCount,0); }
const {profile}=await session.post('Profiler.stop'); session.disconnect();
assert.equal(expected.length,64); assert.equal(journalStreams,0);
fs.writeFileSync('/workspace/reference/profile-warm.json',JSON.stringify(profile));
console.log(JSON.stringify({iterations:100,sessions:6400,messages:total,journalStreams,errors:0,profiled:true}));
