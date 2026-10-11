"""Administrator-only, file-backed integration settings. No credential values in the UI."""
import asyncio
import fcntl
import hashlib
import json
import os
import ssl
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def https_url(value, root_only=False):
    try:
        u = urlsplit(value)
        _ = u.port
        if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment:
            raise ValueError()
        if root_only and u.path not in ('', '/'):
            raise ValueError()
        return value.rstrip('/')
    except ValueError:
        raise ValueError('HTTPS URL without credentials, query or fragment required') from None


class EngineSettings(StrictModel):
    api_url: str = Field(max_length=2048)
    ca_file: str = Field(max_length=1024)
    sso_token_url: str = Field(max_length=2048)
    sso_scope: str = Field(default='ovirt-app-api', min_length=1, max_length=200)
    token_login: bool = False

    @field_validator('api_url', 'sso_token_url')
    @classmethod
    def urls(cls, v):
        return https_url(v)

    @model_validator(mode='after')
    def same_origin(self):
        a, b = urlsplit(self.api_url), urlsplit(self.sso_token_url)
        if (a.hostname, a.port or 443) != (b.hostname, b.port or 443):
            raise ValueError('API and SSO must use the same HTTPS origin')
        return self


class Access(StrictModel):
    namespaces: list[str] = Field(default_factory=list, max_length=200)
    cluster_resources: bool = False
    logs: bool = False
    configmaps: bool = False
    secrets: bool = False
    rbac: bool = False

    @field_validator('namespaces')
    @classmethod
    def namespaces_valid(cls, values):
        from .kubernetes import NAME
        if len(values) != len(set(values)) or any(not NAME.fullmatch(v) for v in values):
            raise ValueError('Use unique namespace names, without wildcards')
        return values


class ClusterSettings(StrictModel):
    id: str = Field(pattern=r'^[a-z0-9][a-z0-9.-]{0,62}$')
    name: str = Field(default='Kubernetes', min_length=1, max_length=120)
    server: str = Field(max_length=2048)
    ca_file: str = Field(max_length=1024)
    token_file: str = Field(max_length=1024)
    users: dict[str, Access]
    node_vm_map: dict[str, str] = Field(default_factory=dict)

    @field_validator('server')
    @classmethod
    def server_valid(cls, value):
        return https_url(value, root_only=True)

    @field_validator('users')
    @classmethod
    def users_valid(cls, value):
        if len(value) > 200 or any(not n or n == '*' or len(n) > 200 for n in value):
            raise ValueError('Use up to 200 explicit usernames')
        return value

    @field_validator('node_vm_map')
    @classmethod
    def mappings_valid(cls, value):
        from .kubernetes import NAME
        if len(value) > 2000 or any(not NAME.fullmatch(n) or not v or len(v) > 128 for n, v in value.items()):
            raise ValueError('Invalid node to VM mapping')
        return value


class EngineWrite(StrictModel):
    revision: str = Field(max_length=64)
    engine: EngineSettings


class ClustersWrite(StrictModel):
    revision: str = Field(max_length=64)
    clusters: list[ClusterSettings] = Field(max_length=50)

    @field_validator('clusters')
    @classmethod
    def unique(cls, value):
        if len({c.id for c in value}) != len(value):
            raise ValueError('Cluster IDs must be unique')
        return value


def credential_file(value, certificate=False):
    root = Path(os.getenv('OMA_CONFIG_CREDENTIAL_ROOT', '/etc/oma/credentials')).resolve()
    path = Path(value)
    try:
        resolved = path.resolve(strict=True)
        if not path.is_absolute() or not resolved.is_relative_to(root) or not resolved.is_file():
            raise ValueError()
        if certificate:
            ssl.create_default_context(cafile=str(resolved))
        elif resolved.stat().st_size > 65536:
            raise ValueError()
        else:
            token = resolved.read_text().strip()
            if not token or any(ch.isspace() for ch in token):
                raise ValueError()
        return str(resolved)
    except (OSError, ValueError):
        raise HTTPException(422, 'Credential file must exist inside OMA_CONFIG_CREDENTIAL_ROOT and have valid contents') from None


def destination(kind):
    value = os.getenv('OMA_ENGINE_CONFIG_FILE' if kind == 'engine' else 'OMA_K8S_CONFIG_FILE', '')
    if not value or not Path(value).is_absolute():
        raise HTTPException(503, 'Server configuration destination is not enabled')
    return Path(value)


def read_document(path):
    try:
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            return None, hashlib.sha256(b'').hexdigest()
        if len(data) > 2 * 1024 * 1024:
            raise ValueError()
        document = json.loads(data)
        if not isinstance(document, dict):
            raise ValueError()
        return document, hashlib.sha256(data).hexdigest()
    except (OSError, ValueError):
        raise HTTPException(503, 'Saved integration configuration cannot be read') from None


def write_document(path, document, revision):
    """Serialize writers and reject stale editors; atomically replace only the configured file."""
    temporary = None
    try:
        with open(str(path) + '.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            _, current = read_document(path)
            if current != revision:
                raise HTTPException(409, 'Configuration changed; reload before saving')
            data = (json.dumps(document, ensure_ascii=False, indent=2) + '\n').encode()
            if len(data) > 2 * 1024 * 1024:
                raise HTTPException(422, 'Configuration exceeds the 2 MiB limit')
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
                temporary = Path(output.name)
                os.fchmod(output.fileno(), 0o600)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
            temporary = None
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        return hashlib.sha256(data).hexdigest()
    except OSError:
        raise HTTPException(503, 'Configuration write failed; check destination permissions and reload before retrying') from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def load_engine_settings():
    """Called once before the Engine globals are initialized; bad saved files fail startup."""
    if not os.getenv('OMA_ENGINE_CONFIG_FILE'):
        return {}
    try:
        document, _ = read_document(destination('engine'))
        if document is None:
            return {}
        return EngineSettings.model_validate(document['engine']).model_dump()
    except (HTTPException, ValueError, KeyError, TypeError):
        raise RuntimeError('Invalid saved Engine configuration; restore the configuration file') from None


def router(session, csrf, audit, active_engine):
    api = APIRouter(prefix='/api/integrations', tags=['Integration settings'])

    def allowed(s):
        names = {n.strip() for n in os.getenv('OMA_CONFIG_ADMINS', '').split(',') if n.strip()}
        return not s.get('demo') and s['username'] in names

    def authorize(request, write=False):
        s = session(request)
        if not allowed(s):
            raise HTTPException(403, 'Integration settings require a configured administrator; demo is read-only')
        if write:
            csrf(request, s)
        return s

    @api.get('/status')
    def status(request: Request):
        s = session(request)
        return {'can_edit': allowed(s), 'demo': bool(s.get('demo'))}

    @api.get('/settings')
    def settings(request: Request):
        authorize(request)
        engine, engine_revision = read_document(destination('engine'))
        clusters, clusters_revision = read_document(destination('kubernetes'))
        try:
            saved = EngineSettings.model_validate(engine['engine']).model_dump() if engine else active_engine()
            validated = ClustersWrite.model_validate({'revision': clusters_revision, 'clusters': clusters['clusters'] if clusters else []})
        except (ValueError, KeyError, TypeError):
            raise HTTPException(503, 'Saved configuration schema is invalid; repair the server file') from None
        return {'engine': saved, 'active_engine': active_engine(), 'engine_revision': engine_revision,
                'clusters': [c.model_dump() for c in validated.clusters], 'clusters_revision': clusters_revision,
                'restart_required': saved != active_engine(),
                'credential_root': os.getenv('OMA_CONFIG_CREDENTIAL_ROOT', '/etc/oma/credentials')}

    @api.put('/engine')
    def save_engine(body: EngineWrite, request: Request):
        s = authorize(request, write=True)
        credential_file(body.engine.ca_file, certificate=True)
        audit('integration.engine.save', s['username'], 'requested')
        revision = write_document(destination('engine'), {'engine': body.engine.model_dump()}, body.revision)
        audit('integration.engine.save', s['username'], 'success')
        return {'revision': revision, 'restart_required': body.engine.model_dump() != active_engine()}

    @api.put('/kubernetes')
    def save_clusters(body: ClustersWrite, request: Request):
        s = authorize(request, write=True)
        for cluster in body.clusters:
            credential_file(cluster.ca_file, certificate=True)
            credential_file(cluster.token_file)
        audit('integration.kubernetes.save', s['username'], 'requested', count=len(body.clusters))
        revision = write_document(destination('kubernetes'), {'clusters': [c.model_dump() for c in body.clusters]}, body.revision)
        audit('integration.kubernetes.save', s['username'], 'success', count=len(body.clusters))
        return {'revision': revision, 'restart_required': False}

    @api.post('/engine/check')
    async def check_engine(body: EngineSettings, request: Request):
        s = authorize(request, write=True)
        ca = credential_file(body.ca_file, certificate=True)
        audit('integration.engine.check', s['username'], 'requested')
        try:
            async with asyncio.timeout(20):
                async with httpx.AsyncClient(verify=ssl.create_default_context(cafile=ca), timeout=15, follow_redirects=False, trust_env=False) as client:
                    async with client.stream('GET', body.api_url, headers={'Accept': 'application/json', 'Version': '4'}) as r:
                        code = r.status_code
            if code not in (200, 401, 403):
                raise HTTPException(502, 'Engine URL responded with an unexpected HTTP status')
            return {'reachable': True, 'http_status': code, 'authentication_checked': False,
                    'message': 'TLS/HTTP reachable. SSO and account permissions must be verified after restart and login.'}
        except (OSError, httpx.HTTPError, TimeoutError):
            raise HTTPException(502, 'Engine TLS or network check failed') from None

    @api.post('/kubernetes/check')
    async def check_cluster(body: ClusterSettings, request: Request):
        s = authorize(request, write=True)
        credential_file(body.ca_file, certificate=True)
        credential_file(body.token_file)
        audit('integration.kubernetes.check', s['username'], 'requested', cluster=body.id)
        from .kubernetes import fetch
        namespaces = sorted({n for access in body.users.values() for n in access.namespaces})
        path = '/api/v1/namespaces/' + namespaces[0] + '/pods' if namespaces else '/api/v1/nodes'
        try:
            async with asyncio.timeout(20):
                await fetch(body.model_dump(), path, {'limit': 1})
        except TimeoutError:
            raise HTTPException(502, 'Kubernetes check timed out') from None
        return {'reachable': True, 'checked_path': path, 'message': 'Selected list request succeeded; other resources require separate RBAC validation.'}

    return api
