#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--before', required=True)
parser.add_argument('--after', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--repeat', type=int, default=5)
parser.add_argument('--side', choices=['before', 'after'])
parser.add_argument('--profile', action='store_true')
args = parser.parse_args()
roots = {'before': Path(args.before).resolve(), 'after': Path(args.after).resolve()}
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
runner = roots['after'] / 'scripts/performance/fixtures/extension-imports.mjs'
hook = roots['after'] / 'scripts/performance/source-hook.mjs'
names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
results = []
for workload in ['async', 'cpu']:
    fixture = out / ('fixture-' + workload)
    fixture.mkdir(exist_ok=True)
    sources = {}
    for index, name in enumerate(names):
        payload = '\n'.join(f'const v{i}: number = {i};' for i in range(2000)) if workload == 'cpu' else ''
        source = f'''import {{ appendFileSync }} from "node:fs";
import {{ performance }} from "node:perf_hooks";
import {{ Type }} from "typebox";
const record = type => appendFileSync(process.env.PI_PERF_EXTENSION_TRACE, JSON.stringify({{type, name: "{name}", at: performance.now()}}) + "\\n");
record("import:start");
{payload}
await new Promise(resolve => setTimeout(resolve, {[60, 50, 40, 30, 20, 10][index] if workload == 'async' else 0}));
record("import:end");
export default async function(pi) {{
    record("factory:start");
    await new Promise(resolve => setTimeout(resolve, 2));
    pi.registerTool({{name: "{name}", label: "{name}", description: "Synthetic tool", parameters: Type.Object({{}}), execute: async () => ({{content: [{{type: "text", text: "ok"}}]}})}});
    pi.registerCommand("{name}", {{ handler: async () => {{}} }});
    pi.registerFlag("{name}-flag", {{type: "string", default: "{name}"}});
    record("factory:end");
}}
'''
        (fixture / (name + '.ts')).write_text(source)
        sources[name] = hashlib.sha256(source.encode()).hexdigest()
    for mode, entry in [('micro', 'dist/bundle/cli.js'), ('rpc', 'dist/bundle/cli.js'), ('rpc', 'dist/cli.js')]:
        sides = [args.side] if args.side else ['before', 'after']
        for run in range(-1, args.repeat):
            for side in sides:
                label = f'{workload}-{mode}-{Path(entry).parent.name}-{side}-{run}'
                area = out / label
                area.mkdir(exist_ok=True)
                for sub in ['home', 'agent', 'tmp', 'cache', 'profiles']:
                    (area / sub).mkdir(exist_ok=True)
                trace = area / 'imports.jsonl'
                if trace.exists():
                    raise RuntimeError('Refusing to overwrite retained trace ' + str(trace))
                cache_temp = out / ('cache-tmp-' + workload + '-' + side)
                cache_temp.mkdir(exist_ok=True)
                env = {'PATH': os.environ['PATH'], 'HOME': str(area / 'home'), 'TMPDIR': str(cache_temp),
                       'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC', 'PI_CODING_AGENT_DIR': str(area / 'agent'),
                       'PI_OFFLINE': '1', 'PI_NO_LOCAL_LLM': '1', 'PI_SKIP_VERSION_CHECK': '1',
                       'PI_PERF_REPO': str(roots[side]), 'PI_PERF_EXTENSION_TRACE': str(trace),
                       'JITI_FS_CACHE': 'true'}
                command = ['node', '--import', str(hook)]
                if args.profile:
                    env.update({'PI_TIMING': '1', 'JITI_DEBUG': '1', 'PI_PERF_PROFILE_DIR': str(area / 'profiles')})
                    if mode == 'micro':
                        command += ['--cpu-prof', '--cpu-prof-dir=' + str(area / 'profiles')]
                command += [str(runner), mode, str(fixture), entry]
                load = os.getloadavg()
                done = subprocess.run(command, cwd=fixture, env=env, capture_output=True, text=True, timeout=60)
                (area / 'stdout.jsonl').write_text(done.stdout)
                (area / 'stderr.log').write_text(done.stderr)
                record = {'workload': workload, 'mode': mode, 'entry': entry, 'side': side, 'run': run,
                          'warmup': run == -1, 'command': command, 'environment': env, 'load': load,
                          'exit': done.returncode, 'sourceHashes': sources, 'directory': str(area)}
                if done.returncode == 0:
                    record['result'] = json.loads(done.stdout.strip().splitlines()[-1])
                results.append(record)
                (out / 'attempts.json').write_text(json.dumps(results, indent=2))
                print(label, done.returncode, record.get('result', {}).get('elapsedMs'), flush=True)
                if done.returncode:
                    sys.exit(done.returncode)
summary = []
for workload in ['async', 'cpu']:
    for mode, entry in [('micro', 'dist/bundle/cli.js'), ('rpc', 'dist/bundle/cli.js'), ('rpc', 'dist/cli.js')]:
        for side in roots:
            samples = [r['result']['elapsedMs'] for r in results if not r['warmup'] and (r['workload'], r['mode'], r['entry'], r['side']) == (workload, mode, entry, side)]
            if samples:
                summary.append({'workload': workload, 'mode': mode, 'entry': entry, 'side': side, 'n': len(samples), 'medianMs': statistics.median(samples), 'minMs': min(samples), 'maxMs': max(samples)})
(out / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
