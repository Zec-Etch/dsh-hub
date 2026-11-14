#!/usr/bin/env python3
"""Build the server archive and checksums after `npm pack --pack-destination dist`."""
from pathlib import Path
import gzip
import hashlib
import json
import tarfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
DIST = ROOT / 'dist'
DIST.mkdir(exist_ok=True)
CLIENT = DIST / f'dsh-hub-agent-{VERSION}.tgz'
if not CLIENT.is_file():
    raise SystemExit('First run: npm pack --ignore-scripts --pack-destination dist')
with tarfile.open(CLIENT) as package:
    metadata = json.load(package.extractfile('package/package.json'))
    if metadata['name'] != 'dsh-hub-agent' or metadata['version'] != VERSION:
        raise SystemExit('Client package identity does not match this release')

SERVER = DIST / f'dsh-hub-server-{VERSION}.tar.gz'
PREFIX = f'dsh-hub-server-{VERSION}'
EXCLUDE = {'node_modules', 'data', '.git', '__pycache__'}
def public_file(info):
    path = Path(info.name)
    if any(part in EXCLUDE for part in path.parts):
        return None
    if path.name.startswith('.env') or path.name in {'hub.json', 'dsh-hub.json', 'dsh-hub-agent.json'} or path.suffix == '.log':
        return None
    if info.issym() or info.islnk():
        raise ValueError(f'Release sources must not contain links: {info.name}')
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    info.mtime = 0
    info.mode = 0o755 if info.isdir() or path.name == 'server.mjs' else 0o644
    return info
with SERVER.open('wb') as output:
    with gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for name in ['hub', 'docs', 'README.md', 'README.zh-CN.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'CHANGELOG.md']:
                source = ROOT / name
                if not source.exists():
                    raise SystemExit(f'Missing release input: {name}')
                archive.add(source, arcname=f'{PREFIX}/{name}', filter=public_file)
checksums = ''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in [CLIENT, SERVER])
(DIST / 'SHA256SUMS').write_text(checksums, encoding='utf-8')
print(checksums, end='')
