#!/usr/bin/env python3
"""Verify locally distributed third-party artifacts without network access."""
import hashlib
import json
from pathlib import Path
root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'public/source/provenance.json').read_text())
for artifact in manifest['localArtifacts']:
    path = root / 'public' / artifact['path']
    data = path.read_bytes()
    if len(data) != artifact['bytes']:
        raise SystemExit(f'Size mismatch: {path}')
    digest = hashlib.sha256(data).hexdigest()
    if digest != artifact['sha256']:
        raise SystemExit(f'Checksum mismatch: {path}')
    print(f'OK {artifact["path"]}')
