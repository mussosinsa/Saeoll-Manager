"""OMA read-first BFF. Production authentication must be validated before enabling writes."""
import os, time, secrets, logging, json, re
from .audit_chain import append_record, AuditWriteError
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
import httpx
from fastapi import FastAPI, Request, HTTPException, Response, Query
from pydantic import BaseModel

app=FastAPI(title='oVirt Modern Admin API',docs_url=None,redoc_url=None)
ENGINE=os.getenv('OVIRT_API_URL','https://engine.example.com/ovirt-engine/api').rstrip('/')
CA=os.getenv('OVIRT_CA_FILE','/etc/pki/ovirt-engine/ca.pem')
DEMO=os.getenv('OMA_DEMO','false').lower()=='true'
if DEMO and (os.getenv('OMA_ALLOW_PASSWORD_LOGIN','false').lower()=='true' or os.getenv('OMA_ENABLE_OVIRT_TOKEN_LOGIN','false').lower()=='true'):
    raise RuntimeError('Demo mode and Engine password login must not both be enabled')
ALLOW_LOGIN=os.getenv('OMA_ALLOW_PASSWORD_LOGIN','false').lower()=='true'
if ALLOW_LOGIN and not DEMO:
    raise RuntimeError('Basic password sessions are disabled in v1.6; use the Engine token flow')
TOKEN_LOGIN=os.getenv('OMA_ENABLE_OVIRT_TOKEN_LOGIN','false').lower()=='true'
SSO_TOKEN_URL=os.getenv('OVIRT_SSO_TOKEN_URL',ENGINE.rsplit('/api',1)[0]+'/sso/oauth/token')
SSO_SCOPE=os.getenv('OVIRT_SSO_SCOPE','ovirt-app-api')
MAX_INVENTORY=max(100,min(int(os.getenv('OMA_MAX_INVENTORY','2000')),10000))
WRITE=os.getenv('OMA_ENABLE_WRITES','false').lower()=='true'
COOKIE_SECURE=os.getenv('OMA_COOKIE_SECURE','true').lower()=='true'
TTL=max(60,min(int(os.getenv('OMA_SESSION_TTL','1800')),3600))
MAX_SESSION_AGE=max(TTL,min(int(os.getenv('OMA_MAX_SESSION_AGE','28800')),86400))
AUDIT=Path(os.getenv('OMA_AUDIT_PATH','/var/log/oma/audit.jsonl'))
SESSIONS={}
LOGIN_ATTEMPTS=defaultdict(deque)
LOGIN_WINDOW=300
LOGIN_LIMIT=5
COLLECTIONS={'vms':'vm','hosts':'host','clusters':'cluster','datacenters':'data_center','storagedomains':'storage_domain','networks':'network','events':'event'}
SUBRES={'nics':'nic','snapshots':'snapshot','diskattachments':'disk_attachment','graphicsconsoles':'graphics_console'}
ACTIONS={'start','shutdown','stop','reboot'}
UUID_RE=re.compile(r'^[a-zA-Z0-9_-]{1,128}$')

def safe_id(value:str):
    if not UUID_RE.fullmatch(value):
        raise HTTPException(422,'Invalid resource identifier')
    return value


class Credentials(BaseModel):
    username:str
    password:str

def log_audit(action,actor,outcome,**extra):
    record={'time':datetime.now(timezone.utc).isoformat(),'action':action,'actor':actor,'outcome':outcome,**extra}
    try:
        append_record(AUDIT,record)
    except AuditWriteError:
        logging.exception('Audit log unavailable or integrity check failed')
        raise HTTPException(503,'Security audit log unavailable')

def demo_data():
    return {
        'datacenters':[{'id':'dc1','name':'Default','status':'up'}],
        'clusters':[{'id':'c1','name':'Production','data_center':{'id':'dc1'}}],
        'hosts':[{'id':'h1','name':'host-01','status':'up','cluster':{'id':'c1'}},{'id':'h2','name':'host-02','status':'up','cluster':{'id':'c1'}}],
        'vms':[{'id':'v1','name':'app-server','status':'up','cpu':{'topology':{'cores':4,'sockets':1,'threads':1}},'memory':8589934592,'cluster':{'id':'c1'},'host':{'id':'h1'}}, {'id':'v2','name':'db-server','status':'down','memory':17179869184,'cluster':{'id':'c1'},'host':{'id':'h2'}},{'id':'v3','name':'web-server','status':'up','memory':4294967296,'cluster':{'id':'c1'},'host':{'id':'h1'}}],
        'storagedomains':[{'id':'s1','name':'data-domain','type':'data','status':'active'}],
        'networks':[{'id':'n1','name':'ovirtmgmt'}],
        'events':[{'id':'e1','description':'Demo environment is active','time':'2026-10-11T00:00:00Z'}]
    }

def check_login_limit(request:Request):
    # In-memory per-client throttle. Deploy behind a trusted proxy and use a
    # shared store for multi-worker/HA deployments. Never trust X-Forwarded-For here.
    peer=request.client.host if request.client else 'unknown'
    now=time.monotonic()
    q=LOGIN_ATTEMPTS[peer]
    while q and now-q[0]>LOGIN_WINDOW:
        q.popleft()
    if len(q)>=LOGIN_LIMIT:
        raise HTTPException(429,'Too many login attempts; retry later')
    return q

def session(req:Request):
    sid=req.cookies.get('oma_session')
    obj=SESSIONS.get(sid)
    if not obj or obj['until']<time.time() or obj.get('absolute_until',0)<time.time():
        SESSIONS.pop(sid,None)
        raise HTTPException(401,'Authentication required')
    if obj.get('access_token') and time.time()>=obj.get('token_expires_at',0):
        SESSIONS.pop(sid,None)
        raise HTTPException(401,'Engine token expired')
    obj['until']=min(time.time()+TTL,obj['absolute_until'])
    return obj

def csrf(req:Request,obj):
    if not secrets.compare_digest(req.headers.get('x-csrf-token',''),obj['csrf']):
        raise HTTPException(403,'CSRF token invalid')

async def engine_call(obj,method,path,body=None,params=None):
    if obj.get('access_token') and time.time()>=obj.get('token_expires_at',0):
        raise HTTPException(401,'Engine token expired')
    try:
        async with httpx.AsyncClient(verify=CA,timeout=25,follow_redirects=False) as client:
            r=await client.request(method,ENGINE+path,auth=(obj['username'],obj['password']) if obj.get('password') else None,headers={**{'Accept':'application/json','Content-Type':'application/xml','Version':'4'},**({'Authorization':'Bearer '+obj['access_token']} if obj.get('access_token') else {})},content=body,params=params)
        if r.status_code in (401,403): raise HTTPException(r.status_code,'Engine permission denied')
        if r.status_code>=400: raise HTTPException(502,f'Engine returned HTTP {r.status_code}')
        return r.json() if r.content and 'json' in r.headers.get('content-type','') else {}
    except httpx.HTTPError as e:
        logging.warning('Engine connection error: %s',type(e).__name__)
        raise HTTPException(502,'Engine connection failed')

def normalize(data,key):
    # oVirt collections generally have {vms:{vm:[...]}}; tolerate empty responses.
    group=data.get(key,{}) if isinstance(data,dict) else {}
    if isinstance(group,dict): return group.get(COLLECTIONS.get(key,SUBRES.get(key,key)),[]) or []
    return group if isinstance(group,list) else []

@app.get('/api/capabilities')
def capabilities():
    return {'version':'1.8.0','demo':DEMO,'engine_login_enabled':(ALLOW_LOGIN or TOKEN_LOGIN) and not DEMO,'writes_enabled':False,'console_connection':False,'sso_verified':False,'inventory_pagination':'bounded_snapshot','note':'Read-only integration; chained local audit records are tamper-evident but not tamper-proof; Engine RBAC unverified'}

@app.get('/api/health/live')
def live():return {'status':'ok','version':'1.8.0','demo':DEMO}

@app.post('/api/auth/login')
async def login(creds:Credentials,response:Response,request:Request):
    attempts=check_login_limit(request)
    if not DEMO and not TOKEN_LOGIN:
        raise HTTPException(503,'Login disabled until Engine authentication is configured')
    token=None
    expiry=0
    if DEMO:
        if creds.username!='demo' or creds.password!='demo':
            attempts.append(time.monotonic())
            raise HTTPException(401,'Invalid demo credentials')
    elif TOKEN_LOGIN:
        try:
            async with httpx.AsyncClient(verify=CA,timeout=20,follow_redirects=False) as client:
                r=await client.post(SSO_TOKEN_URL,data={'grant_type':'password','username':creds.username,'password':creds.password,'scope':SSO_SCOPE},headers={'Accept':'application/json'})
            if r.status_code in (400,401,403):
                log_audit('login',creds.username,'denied')
                attempts.append(time.monotonic())
                raise HTTPException(401,'Engine authentication rejected')
            if r.status_code!=200:
                raise HTTPException(502,'Engine SSO unavailable')
            payload=r.json()
            token=payload.get('access_token')
            if not isinstance(token,str) or not token:
                raise HTTPException(502,'Engine SSO returned no access token')
            expiry=time.time()+max(1,int(payload.get('expires_in',300))-15)
            await engine_call({'access_token':token,'token_expires_at':expiry},'GET','/')
        except (httpx.HTTPError,ValueError,TypeError):
            raise HTTPException(502,'Engine SSO connection or response failed')
    else:
        raise HTTPException(503,'Token authentication is required')
    attempts.clear()
    sid=secrets.token_urlsafe(32)
    csrf_token=secrets.token_urlsafe(32)
    log_audit('login',creds.username,'success',demo=DEMO)
    SESSIONS[sid]={'username':creds.username,'password':'',
                   'access_token':token,'token_expires_at':expiry,'csrf':csrf_token,
                   'until':time.time()+TTL,'absolute_until':time.time()+MAX_SESSION_AGE,'demo':DEMO}
    if token:
        SESSIONS[sid]['absolute_until']=min(SESSIONS[sid]['absolute_until'],expiry)
        SESSIONS[sid]['until']=min(SESSIONS[sid]['until'],expiry)
    response.set_cookie('oma_session',sid,httponly=True,secure=COOKIE_SECURE,samesite='strict',max_age=TTL,path='/api')
    return {'username':creds.username,'csrf':csrf_token,'demo':DEMO,'writes_enabled':False}

@app.get('/api/auth/me')
def me(request:Request):
    s=session(request)
    return {'username':s['username'],'csrf':s['csrf'],'demo':s['demo'],'writes_enabled':WRITE and not s['demo'] and False}

@app.post('/api/auth/logout')
def logout(request:Request,response:Response):
    s=session(request);csrf(request,s)
    SESSIONS.pop(request.cookies.get('oma_session'),None)
    response.delete_cookie('oma_session',path='/api')
    log_audit('logout',s['username'],'success')
    return {'ok':True}

@app.middleware('http')
async def browser_protections(request:Request,call_next):
    # Defense-in-depth for cookie authenticated writes: reject cross-site fetches.
    if request.method in ('POST','PUT','PATCH','DELETE'):
        site=request.headers.get('sec-fetch-site','')
        if site and site not in ('same-origin','none'):
            return Response(status_code=403,content='Cross-site request blocked')
    response=await call_next(request)
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['Referrer-Policy']='no-referrer'
    response.headers['Cache-Control']='no-store'
    return response

@app.get('/api/inventory/{resource}/page')
async def inventory_page(resource:str,request:Request,page:int=Query(1,ge=1,le=100000),page_size:int=Query(50,ge=1,le=200)):
    s=session(request)
    if resource not in COLLECTIONS:raise HTTPException(404,'Unknown resource')
    if DEMO:
        items=demo_data()[resource]
        start=(page-1)*page_size
        return {'items':items[start:start+page_size], 'page':page,'page_size':page_size,'has_more':start+page_size<len(items),'total':len(items)}
    data=await engine_call(s,'GET','/'+resource,params={'max':MAX_INVENTORY+1})
    items=normalize(data,resource)
    if len(items)>MAX_INVENTORY:
        raise HTTPException(413,'Inventory exceeds snapshot limit')
    start=(page-1)*page_size
    return {'items':items[start:start+page_size],'page':page,'page_size':page_size,
            'has_more':start+page_size<len(items),'total':len(items),'mode':'bounded_snapshot'}

@app.get('/api/inventory/{resource}')
async def inventory(resource:str,request:Request):
    s=session(request)
    if resource not in COLLECTIONS: raise HTTPException(404,'Unknown resource')
    if DEMO:return {'items':demo_data()[resource]}
    data=await engine_call(s,'GET','/'+resource,params={'max':MAX_INVENTORY+1})
    items=normalize(data,resource)
    if len(items)>MAX_INVENTORY:
        raise HTTPException(413,'Inventory exceeds configured snapshot limit')
    return {'items':items}

@app.get('/api/vms/{vm_id}')
async def vm_detail(vm_id:str,request:Request):
    s=session(request)
    safe_id(vm_id)
    if DEMO:
        vm=next((x for x in demo_data()['vms'] if x['id']==vm_id),None)
        if vm:return vm
        raise HTTPException(404,'VM not found')
    data=await engine_call(s,'GET','/vms/'+vm_id)
    return data.get('vm',data)

@app.get('/api/vms/{vm_id}/{subresource}')
async def vm_children(vm_id:str,subresource:str,request:Request):
    s=session(request)
    safe_id(vm_id)
    if subresource not in SUBRES:raise HTTPException(404,'Unknown subresource')
    if DEMO:return {'items':({'nics':[{'id':'nic1','name':'eth0','interface':'virtio'}], 'diskattachments':[{'id':'d1','bootable':True,'disk':{'name':'system-disk'}}], 'snapshots':[{'id':'snap1','description':'Initial snapshot'}], 'graphicsconsoles':[{'id':'g1','protocol':'vnc'}]}).get(subresource,[])}
    data=await engine_call(s,'GET',f'/vms/{vm_id}/{subresource}')
    return {'items':normalize(data,subresource)}

@app.post('/api/vms/{vm_id}/actions/{action}')
async def vm_action(vm_id:str,action:str,request:Request):
    s=session(request);csrf(request,s)
    safe_id(vm_id)
    if action not in ACTIONS:raise HTTPException(404,'Unknown action')
    # Deliberate hard gate: this release does not attest SSO identity / RBAC.
    log_audit('vm_'+action,s['username'],'blocked',vm_id=vm_id)
    raise HTTPException(403,'VM changes disabled pending verified SSO/RBAC integration')


@app.get('/api/health/engine')
async def engine_health(request:Request):
    # Authenticated check, not a public readiness probe.
    s=session(request)
    if DEMO:
        return {'status':'demo','engine_connected':False}
    await engine_call(s,'GET','/')
    return {'status':'connected','engine_connected':True}

@app.get('/api/health/ready')
async def ready():
    # Does not leak Engine connection details or require user credentials.
    if not DEMO and not CA.startswith('/'):
        raise HTTPException(503,'CA file path must be absolute')
    if not DEMO and not Path(CA).is_file():
        raise HTTPException(503,'Engine CA certificate not configured')
    return {'status':'ready','mode':'demo' if DEMO else 'configured','version':'1.8.0','engine_connection_checked':False}

@app.get('/api/audit/events')
async def audit_events(request:Request, limit:int=Query(50,ge=1,le=200)):
    # Engine events are visible only through the current user's Engine token.
    s=session(request)
    if DEMO:
        return {'items':demo_data()['events'][:limit], 'source':'demo'}
    data=await engine_call(s,'GET','/events',params={'max':limit})
    return {'items':normalize(data,'events')[:limit], 'source':'ovirt-engine'}


@app.get('/api/diagnostics')
def diagnostics(request:Request):
    """Authenticated configuration report, no credentials or tokens returned."""
    s=session(request)
    return {
        'version':'1.8.0',
        'mode':'demo' if DEMO else 'engine',
        'auth_mode':'demo' if DEMO else ('engine_password_grant' if TOKEN_LOGIN else 'disabled'),
        'authenticated_session':True,
        'engine_identity_verified':False,
        'rbac_write_verified':False,
        'vm_writes_allowed':False,
        'console_ticket_supported':False,
        'audit_sink_configured':AUDIT.parent.is_dir(),
        'audit_chain_format':'sha256-v1',
    }
