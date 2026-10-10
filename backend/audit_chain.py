"""Append-only, SHA-256 hash-linked audit records. Not a substitute for remote WORM logging."""
import hashlib
import json
import os
import fcntl
import hmac
import secrets
import tempfile
from pathlib import Path

class AuditWriteError(Exception):
    pass

def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

def digest(previous, record):
    return hashlib.sha256(previous.encode('ascii') + b'\n' + canonical(record)).hexdigest()

def verify(path):
    path=Path(path)
    previous='0'*64
    count=0
    try:
        with path.open('rb') as stream:
            for count, raw in enumerate(stream, 1):
                entry=json.loads(raw)
                if not isinstance(entry,dict) or set(entry)!={'previous_hash','record','hash'}:
                    raise ValueError(f'Invalid entry at line {count}')
                if entry['previous_hash']!=previous or entry['hash']!=digest(previous,entry['record']):
                    raise ValueError(f'Hash mismatch at line {count}')
                previous=entry['hash']
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, KeyError) as exc:
        raise AuditWriteError(f'Cannot verify audit chain at line {count}: {exc}') from exc
    return {'records':count,'last_hash':previous}

def append_record(path,record):
    path=Path(path)
    try:
        path.parent.mkdir(mode=0o750,parents=True,exist_ok=True)
        # A separate lock file prevents concurrent writers from racing and avoids
        # relying on advisory locks against the log inode after rotation.
        lock_path=path.with_name(path.name+'.lock')
        fd=os.open(lock_path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        try:
            with os.fdopen(fd,'rb+') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                if path.exists():
                    state=verify(path)
                else:
                    state={'records':0,'last_hash':'0'*64}
                prev=state['last_hash']
                entry={'previous_hash':prev,'record':record,'hash':digest(prev,record)}
                log_fd=os.open(path,os.O_CREAT|os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW,0o600)
                with os.fdopen(log_fd,'ab') as stream:
                    stream.write(canonical(entry)+b'\n')
                    stream.flush()
                    os.fsync(stream.fileno())
                return entry['hash']
        except Exception:
            raise
    except (OSError,ValueError,TypeError) as exc:
        raise AuditWriteError(str(exc)) from exc


# HMAC-signed checkpoint for independent storage. The signing key and checkpoint
# MUST live outside the audited host's trust boundary in production.
def _checkpoint_payload(records, last_hash):
    return {'format': 'oma-audit-anchor-v1', 'records': records, 'last_hash': last_hash}

def _anchor_mac(payload, key):
    if len(key) < 32:
        raise ValueError('Anchor key must be at least 32 bytes')
    return hmac.new(key, canonical(payload), hashlib.sha256).hexdigest()

def create_anchor(log_path, anchor_path, key):
    log_path, anchor_path = Path(log_path), Path(anchor_path)
    state = verify(log_path)
    payload = _checkpoint_payload(state['records'], state['last_hash'])
    envelope = {'checkpoint': payload, 'mac': _anchor_mac(payload, key)}
    # Refuse to overwrite an anchor if its previous checkpoint is not still
    # present in the current chain. This detects truncation before re-anchoring.
    if anchor_path.exists():
        verify_anchor(log_path, anchor_path, key)
    anchor_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.oma-anchor-', dir=anchor_path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(canonical(envelope) + b'\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, anchor_path)
        dirfd = os.open(anchor_path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(dirfd)
        finally: os.close(dirfd)
    finally:
        if os.path.exists(name): os.unlink(name)
    return envelope

def verify_anchor(log_path, anchor_path, key):
    anchor = json.loads(Path(anchor_path).read_bytes())
    if not isinstance(anchor, dict) or set(anchor) != {'checkpoint', 'mac'}:
        raise ValueError('Invalid anchor structure')
    checkpoint = anchor['checkpoint']
    if not isinstance(checkpoint, dict) or set(checkpoint) != {'format','records','last_hash'} or checkpoint['format'] != 'oma-audit-anchor-v1':
        raise ValueError('Invalid checkpoint')
    if not hmac.compare_digest(str(anchor['mac']), _anchor_mac(checkpoint, key)):
        raise ValueError('Anchor signature mismatch')
    target = checkpoint['records']
    if type(target) is not int or target < 0:
        raise ValueError('Invalid anchored record count')
    # Verify the *entire* current chain and the anchored prefix, not just tail.
    current = verify(log_path)
    if current['records'] < target:
        raise ValueError('Audit log truncated below anchored record count')
    prefix = '0'*64
    with Path(log_path).open('rb') as stream:
        for i, raw in enumerate(stream):
            if i >= target: break
            prefix = json.loads(raw)['hash']
    if not secrets.compare_digest(prefix, checkpoint['last_hash']):
        raise ValueError('Anchored audit prefix mismatch')
    return {'ok': True, 'anchored_records': target, 'current_records': current['records'], 'anchored_hash': prefix}
