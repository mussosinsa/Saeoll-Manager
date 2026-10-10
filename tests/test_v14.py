import os
os.environ.setdefault('OMA_DEMO','true')
from fastapi.testclient import TestClient
from backend.app import app

def test_ready_demo():
    r=TestClient(app).get('/api/health/ready')
    assert r.status_code==200 and r.json()['version']== '1.8.0'

def test_audit_requires_login():
    assert TestClient(app).get('/api/audit/events').status_code==401

def test_audit_demo_and_id_validation():
    with TestClient(app) as c:
        assert c.post('/api/auth/login',json={'username':'demo','password':'demo'}).status_code==200
        assert c.get('/api/audit/events').json()['source']=='demo'
        assert c.get('/api/vms/invalid%20id').status_code==422
        assert c.get('/api/vms/v1').status_code==200
