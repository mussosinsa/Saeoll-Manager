#!/usr/bin/env python3
"""Verify a local OMA SHA-256 audit chain; exits nonzero on tampering."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.audit_chain import verify, AuditWriteError

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('path',help='audit.jsonl path')
    args=parser.parse_args()
    try:
        result=verify(args.path)
        print(json.dumps({'ok':True,**result}))
    except (AuditWriteError,ValueError) as exc:
        print(json.dumps({'ok':False,'error':str(exc)}),file=sys.stderr)
        return 1
    return 0
if __name__=='__main__':
    sys.exit(main())
