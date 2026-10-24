import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { SessionManager } from '/workspace/pi-251/packages/coding-agent/dist/index.js';
const root='/workspace/reference/timezone-repro';
mkdirSync(root,{recursive:true});
if(process.argv[2]==='seed') writeFileSync(root+'/one.jsonl',JSON.stringify({type:'session',version:3,id:'timezone',timestamp:'2026-10-24T12:00:00',cwd:root})+'\n');
if(process.argv[2]==='clear') rmSync(root+'/.session-list-cache-v1',{recursive:true,force:true});
const [info]=await SessionManager.listAll(root);
console.log(JSON.stringify({TZ:process.env.TZ,created:info.created.toISOString(),modified:info.modified.toISOString()}));
