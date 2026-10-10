import os
os.environ['OMA_DEMO']='true'
os.environ['OMA_COOKIE_SECURE']='false'
from fastapi.testclient import TestClient
from backend.app import app

def test_demo_pagination_and_validation():
    with TestClient(app) as c:
        assert c.post('/api/auth/login',json={'username':'demo','password':'demo'}).status_code==200
        a=c.get('/api/inventory/vms/page?page=1&page_size=2')
        assert a.status_code==200
        assert len(a.json()['items'])==2 and a.json()['has_more']
        b=c.get('/api/inventory/vms/page?page=2&page_size=2')
        assert len(b.json()['items'])==1 and not b.json()['has_more']
        assert c.get('/api/inventory/vms/page?page=0').status_code==422
        assert c.get('/api/inventory/vms/page?page_size=201').status_code==422
        assert c.get('/api/inventory/invalid/page').status_code==404

def test_cross_site_post_rejected():
    with TestClient(app) as c:
        r=c.post('/api/auth/login',json={'username':'demo','password':'demo'},headers={'sec-fetch-site':'cross-site'})
        assert r.status_code==403
