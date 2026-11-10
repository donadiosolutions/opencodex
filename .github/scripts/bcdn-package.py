"""Inspect npm archive bytes as data; never extract or execute selected code."""
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath

archive, prepared, output = map(Path, sys.argv[1:])
manifest_bytes = prepared.read_bytes()
manifest = json.loads(manifest_bytes)
expected = {row['path']: row['sha256'] for row in manifest['files']}
files = {}
total_size = 0
with tarfile.open(archive, 'r:gz') as package:
    for member in package:
        path = PurePosixPath(member.name)
        if (not member.name.startswith('package/') or str(path) != member.name.rstrip('/')
                or any(part in ('', '.', '..') for part in member.name.rstrip('/').split('/'))
                or '\\' in member.name or len(member.name) > 500):
            raise ValueError('Unsafe package archive path')
        if member.isdir():
            continue
        if not member.isfile() or member.name in files or member.size > 100_000_000:
            raise ValueError('Non-regular, duplicate or oversized package entry')
        total_size += member.size
        if total_size > 500_000_000 or len(files) >= 20_000:
            raise ValueError('Package exceeds archive inventory limits')
        data = package.extractfile(member).read()
        files[member.name] = {'path': member.name, 'sha256': hashlib.sha256(data).hexdigest(),
                              'size': len(data), 'mode': member.mode & 0o777}
        if member.name == 'package/package.json':
            metadata = json.loads(data)
        if member.name == 'package/src/generated/compatibility-version.json' and data != manifest_bytes:
            raise ValueError('Package compatibility manifest differs from prepared source')

required = ['package.json', 'gui/dist/index.html', 'bin/ocx.mjs', 'bin/package-main.mjs',
            'src/generated/compatibility-version.json', 'README.md', 'LICENSE', 'AGENTS_INSTALL.md',
            'native/remote-workspace-helper/Cargo.toml', 'native/remote-workspace-helper/Cargo.lock',
            'native/ocx-child/Cargo.toml', 'native/ocx-child/Cargo.lock',
            'native/ocx-child/src/lib.rs', 'native/ocx-child/src/main.rs']
if any(f'package/{name}' not in files for name in required):
    raise ValueError('Missing required package files')
if metadata['name'] != '@bitkyc08/opencodex' or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', metadata['version']):
    raise ValueError('Unexpected npm package identity')
if metadata.get('bin') != {'ocx': './bin/ocx.mjs', 'opencodex': './bin/ocx.mjs'}:
    raise ValueError('Unexpected package launcher')
if files['package/bin/ocx.mjs']['mode'] != 0o755:
    raise ValueError('Package launcher must be executable')
for path, hash_value in expected.items():
    if path.startswith('src/') or path == 'package.json':
        if files.get(f'package/{path}', {}).get('sha256') != hash_value:
            raise ValueError(f'Package differs from selected source: {path}')
actual_src = {name.removeprefix('package/') for name in files if name.startswith('package/src/')}
if actual_src != {name for name in expected if name.startswith('src/')} | {'src/generated/compatibility-version.json'}:
    raise ValueError('Unexpected package source inventory')
allowed_roots = {'bin', 'src', 'gui', 'assets', 'native', 'README.md', 'SPONSORS.md',
                 'AGENTS_INSTALL.md', 'LICENSE', 'package.json'}
if any(name.split('/')[1] not in allowed_roots for name in files):
    raise ValueError('Unexpected repository-only package input')
result = {'schema_version': 1, 'package_name': metadata['name'], 'package_version': metadata['version'],
          'package_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
          'package_sha512': hashlib.sha512(archive.read_bytes()).hexdigest(),
          'files': [files[name] for name in sorted(files)]}
output.write_text(json.dumps(result, indent=2) + '\n')
print(f"Verified {len(files)} package files for {metadata['name']}@{metadata['version']}")
