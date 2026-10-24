import os, pty, fcntl, termios, struct, subprocess, select, time, json, signal
root='/workspace/reference/cli-proof'
receipt_path=root+'/receipts.jsonl'
previous_receipts=sum(1 for _ in open(receipt_path)) if os.path.exists(receipt_path) else 0
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
env={'PATH':os.environ['PATH'],'HOME':root+'/home','PI_CODING_AGENT_DIR':root+'/home/agent','PI_OFFLINE':'1','PI_NO_LOCAL_LLM':'1','PI_PERF_REPO':'/workspace/pi-251','TERM':'xterm-256color','LANG':'C.UTF-8'}
command=['node','--import','/workspace/pi-251/scripts/performance/source-hook.mjs','/workspace/pi-251/packages/coding-agent/dist/bundle/cli.js','--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','-e',root+'/proof-extension.ts','--resume','--session-dir',root+'/journals']
p=subprocess.Popen(command,cwd=root+'/work',env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
output=bytearray(); selected=False; sent_query=False; sent_enter=False; failure=None
start=time.monotonic()
try:
 while time.monotonic()-start<30:
  ready,_,_=select.select([master],[],[],0.05)
  if ready:
   try: chunk=os.read(master,65536)
   except OSError: chunk=b''
   output.extend(chunk)
  if not sent_query and b'Resume Session' in output:
   os.write(master,b'"tail unique two"'); sent_query=True; query_time=time.monotonic()
  if sent_query and not sent_enter and time.monotonic()-query_time>0.3:
   os.write(master,b'\r'); sent_enter=True
  receipt=root+'/receipts.jsonl'
  if os.path.exists(receipt):
   records=[json.loads(line) for line in open(receipt) if line.strip()][previous_receipts:]
   selected=any(r.get('event')=='session_start' and r.get('id')=='public-cli-two' for r in records)
   if selected:
    os.write(master,b'\x04')
    break
  if p.poll() is not None: break
 if not selected: raise AssertionError('CLI did not resume public-cli-two after a full-text tail query')
 p.wait(timeout=10)
 if p.returncode!=0: raise AssertionError('CLI exit '+str(p.returncode))
except Exception as e:
 failure=str(e)
finally:
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try: p.wait(timeout=5)
  except subprocess.TimeoutExpired:
   os.killpg(p.pid,signal.SIGKILL); p.wait()
 try:
  while select.select([master],[],[],0)[0]: output.extend(os.read(master,65536))
 except OSError: pass
 os.close(master)
 open(root+'/terminal-final.raw.txt','wb').write(output)
 json.dump({'command':command,'selected':selected,'query':'"tail unique two"','exitCode':p.returncode,'failure':failure,'outboundNetwork':'Disabled by the existing performance offline hook; no model prompt sent','claim':'Functional built Linux CLI PTY proof only, not a latency measurement.'},open(root+'/pty-result-final.json','w'),indent=2)
if failure: raise AssertionError(failure)
print('Built bundled CLI resumed public-cli-two through the real PTY resume picker and full-text tail search; exit 0.')
