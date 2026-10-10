import os
os.environ.setdefault('OMA_DEMO','true')
from fastapi.testclient import TestClient
from backend.app import app, LOGIN_ATTEMPTS

def test_engine_health_requires_auth():
    with TestClient(app) as c:
        assert c.get('/api/health/engine').status_code == 401
        assert c.post('/api/auth/login',json={'username':'demo','password':'demo'}).status_code == 200
        assert c.get('/api/health/engine').json() == {'status':'demo','engine_connected':False}

def test_login_throttle():
    LOGIN_ATTEMPTS.clear()
    with TestClient(app) as c:
        for _ in range(5):
            assert c.post('/api/auth/login',json={'username':'demo','password':'wrong'}).status_code == 401
        assert c.post('/api/auth/login',json={'username':'demo','password':'demo'}).status_code == 429
    LOGIN_ATTEMPTS.clear()

def test_readiness_is_not_engine_check():
    with TestClient(app) as c:
        assert c.get('/api/health/ready').json()['engine_connection_checked'] is False
