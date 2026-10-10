#!/usr/bin/env python3
"""Create/verify a signed audit checkpoint; keep the key and anchor off-host."""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.audit_chain import create_anchor, verify_anchor

parser=argparse.ArgumentParser()
parser.add_argument('command', choices=['create','verify'])
parser.add_argument('--log', required=True)
parser.add_argument('--anchor', required=True)
parser.add_argument('--key-file', required=True, help='binary secret, >=32 bytes; never store with audit log')
args=parser.parse_args()
try:
    stat=os.stat(args.key_file)
    if stat.st_mode & 0o077:
        raise ValueError('Key file permissions must be 0600 or stricter')
    key=Path(args.key_file).read_bytes()
    result=(create_anchor if args.command=='create' else verify_anchor)(args.log,args.anchor,key)
    print(result)
except (OSError, ValueError, TypeError) as exc:
    print(f'ERROR: {exc}',file=sys.stderr)
    sys.exit(1)
