import {appendFileSync} from 'node:fs';
export default function(pi) { pi.on('session_start', (_event,ctx) => appendFileSync('/workspace/reference/cli-proof/receipts.jsonl',JSON.stringify({event:'session_start',id:ctx.sessionManager.getSessionId(),path:ctx.sessionManager.getSessionFile()})+'\n')); }
