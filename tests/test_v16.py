import os, importlib, pytest
from fastapi.testclient import TestClient

def test_diagnostics_auth_required(monkeypatch):
    monkeypatch.setenv('OMA_DEMO','true')
    monkeypatch.setenv('OMA_COOKIE_SECURE','false')
    import backend.app as mod
    importlib.reload(mod)
    client=TestClient(mod.app)
    assert client.get('/api/diagnostics').status_code==401
    r=client.post('/api/auth/login',json={'username':'demo','password':'demo'})
    assert r.status_code==200
    data=client.get('/api/diagnostics').json()
    assert data['vm_writes_allowed'] is False
    assert data['engine_identity_verified'] is False
    assert 'access_token' not in data

def test_basic_login_disabled(monkeypatch):
    monkeypatch.setenv('OMA_DEMO','false')
    monkeypatch.setenv('OMA_ALLOW_PASSWORD_LOGIN','true')
    import backend.app as mod
    with pytest.raises(RuntimeError,match='Basic password sessions'):
        importlib.reload(mod)
