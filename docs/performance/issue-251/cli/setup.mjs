import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '/workspace/pi-251/packages/coding-agent/dist/index.js';
const root = '/workspace/reference/cli-proof';
for (const dir of ['home/agent','work','journals']) mkdirSync(join(root,dir),{recursive:true});
writeFileSync(join(root,'home/agent/settings.json'), JSON.stringify({tuiMode:'regular',quietStartup:true,enableInstallTelemetry:false,experimental:{firstTimeSetup:false}}));
for (const suffix of ['one','two']) {
 const manager=SessionManager.create(join(root,'work'),join(root,'journals'),{id:`public-cli-${suffix}`});
 const initial=manager.appendMessage({role:'user',content:`public synthetic first ${suffix}`,timestamp:1792800000000});
 manager.appendMessage({role:'user',content:`tail unique ${suffix}`,timestamp:1792800000001});
 manager.branch(initial);
 manager.appendSessionInfo(`CLI ${suffix}`);
}
const cold=await SessionManager.listAll(join(root,'journals'));
const warm=await SessionManager.listAll(join(root,'journals'));
if (JSON.stringify(cold)!==JSON.stringify(warm)||cold.length!==2||cold.some(s=>s.messageCount!==2)) throw Error('built SDK listing mismatch');
writeFileSync(join(root,'sdk-receipt.json'),JSON.stringify({sdk:'/workspace/pi-251/packages/coding-agent/dist/index.js',sessions:cold},null,2));
writeFileSync(join(root,'proof-extension.ts'),`import {appendFileSync} from 'node:fs';\nexport default function(pi) { pi.on('session_start', (_event,ctx) => appendFileSync('/workspace/reference/cli-proof/receipts.jsonl',JSON.stringify({event:'session_start',id:ctx.sessionManager.getSessionId(),path:ctx.sessionManager.getSessionFile()})+'\\n')); }\n`);
console.log('Built SDK cold/warm listings match with two exact-count synthetic sessions.');
