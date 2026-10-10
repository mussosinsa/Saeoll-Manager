import json
import pytest
from backend.audit_chain import append_record, verify, AuditWriteError

def test_audit_chain_roundtrip(tmp_path):
    path=tmp_path/'audit.jsonl'
    append_record(path,{'action':'login','actor':'demo'})
    append_record(path,{'action':'logout','actor':'demo'})
    assert verify(path)['records']==2
    assert path.stat().st_mode & 0o777 == 0o600

def test_audit_tampering_detected(tmp_path):
    path=tmp_path/'audit.jsonl'
    append_record(path,{'actor':'alice'})
    path.write_text(path.read_text().replace('alice','mallory'))
    with pytest.raises(ValueError,match='Hash mismatch'):
        verify(path)
    with pytest.raises(AuditWriteError):
        append_record(path,{'actor':'bob'})

def test_audit_reordering_detected(tmp_path):
    path=tmp_path/'audit.jsonl'
    append_record(path,{'actor':'alice'})
    append_record(path,{'actor':'bob'})
    lines=path.read_text().splitlines()
    path.write_text('\n'.join(reversed(lines))+'\n')
    with pytest.raises(ValueError,match='Hash mismatch'):
        verify(path)

def test_vm_actions_still_blocked(monkeypatch,tmp_path):
    import importlib
    from fastapi.testclient import TestClient
    monkeypatch.setenv('OMA_DEMO','true')
    monkeypatch.setenv('OMA_COOKIE_SECURE','false')
    monkeypatch.setenv('OMA_ENABLE_WRITES','true')
    monkeypatch.setenv('OMA_AUDIT_PATH',str(tmp_path/'audit.jsonl'))
    import backend.app as mod
    importlib.reload(mod)
    client=TestClient(mod.app)
    login=client.post('/api/auth/login',json={'username':'demo','password':'demo'})
    assert login.status_code==200
    csrf=login.json()['csrf']
    response=client.post('/api/vms/v1/actions/start',headers={'x-csrf-token':csrf})
    assert response.status_code==403
    assert verify(tmp_path/'audit.jsonl')['records']==2
