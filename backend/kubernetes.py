"""Read-only multi-cluster gateway. Credentials and upstream URLs are server-managed."""
import json
import os
import re
import ssl
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Query, Request

NAME = re.compile(r"^[a-z0-9][a-z0-9.-]{0,252}$")
RESOURCES = {
    "pods": "/api/v1", "events": "/api/v1", "configmaps": "/api/v1",
    "secrets": "/api/v1", "deployments": "/apis/apps/v1",
    "statefulsets": "/apis/apps/v1", "daemonsets": "/apis/apps/v1",
    "jobs": "/apis/batch/v1", "cronjobs": "/apis/batch/v1",
    "roles": "/apis/rbac.authorization.k8s.io/v1",
    "rolebindings": "/apis/rbac.authorization.k8s.io/v1",
    "podmetrics": "/apis/metrics.k8s.io/v1beta1",
}
CLUSTER_RESOURCES = {
    "nodes": "/api/v1/nodes",
    "nodemetrics": "/apis/metrics.k8s.io/v1beta1/nodes",
    "clusterroles": "/apis/rbac.authorization.k8s.io/v1/clusterroles",
    "clusterrolebindings": "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings",
}


def name(value):
    if not NAME.fullmatch(value):
        raise HTTPException(422, "Invalid Kubernetes resource identifier")
    return value


def require(condition):
    if not condition:
        raise ValueError("Invalid Kubernetes configuration")


def configurations():
    location = os.getenv("OMA_K8S_CONFIG_FILE", "")
    if not location:
        return []
    try:
        entries = json.loads(Path(location).read_text())["clusters"]
        require(isinstance(entries, list) and len(entries) <= 50)
        identifiers = set()
        for c in entries:
            require(isinstance(c, dict) and NAME.fullmatch(c["id"]))
            require(c["id"] not in identifiers)
            identifiers.add(c["id"])
            url = urlsplit(c["server"])
            require(url.scheme == "https" and url.hostname and not url.username and not url.password)
            require(url.path in ("", "/") and not url.query and not url.fragment)
            require(Path(c["ca_file"]).is_absolute() and Path(c["token_file"]).is_absolute())
            require(isinstance(c["users"], dict))
            for username, access in c["users"].items():
                require(isinstance(username, str) and username and username != "*")
                require(isinstance(access["namespaces"], list))
                require(all(isinstance(n, str) and NAME.fullmatch(n) for n in access["namespaces"]))
                for flag in ("cluster_resources", "logs", "configmaps", "secrets", "rbac"):
                    require(isinstance(access.get(flag, False), bool))
            require(isinstance(c.get("node_vm_map", {}), dict))
            require(all(isinstance(k, str) and isinstance(v, str) for k, v in c.get("node_vm_map", {}).items()))
        return entries
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(503, "Kubernetes server configuration is invalid") from None


async def fetch(cluster, path, params=None, text=False):
    """Bound response size and timeout; never forward credential-bearing upstream errors."""
    try:
        token = Path(cluster["token_file"]).read_text().strip()
        if not token or any(c.isspace() for c in token):
            raise ValueError("Invalid token")
        context = ssl.create_default_context(cafile=cluster["ca_file"])
        async with httpx.AsyncClient(verify=context, timeout=15, follow_redirects=False, trust_env=False) as client:
            async with client.stream("GET", cluster["server"].rstrip("/") + path,
                                     params=params, headers={"Authorization": "Bearer " + token,
                                                             "Accept": "text/plain" if text else "application/json"}) as response:
                if response.status_code == 403:
                    raise HTTPException(403, "Kubernetes service account lacks permission")
                if response.status_code == 404:
                    raise HTTPException(404, "Kubernetes resource or API unavailable")
                if response.status_code == 401:
                    raise HTTPException(502, "Kubernetes service account authentication failed")
                if response.status_code != 200:
                    raise HTTPException(502, "Kubernetes API request failed")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > (65536 if text else 2 * 1024 * 1024):
                        raise HTTPException(502, "Kubernetes response too large; narrow the query")
        return data.decode("utf-8", errors="replace") if text else json.loads(data)
    except (OSError, ValueError, httpx.HTTPError):
        raise HTTPException(502, "Kubernetes connection, certificate, or response failed") from None


def project(item, resource, cluster):
    """Allowlisted projections: omit annotations, raw Pod specs, env values and Secret data."""
    if not isinstance(item, dict) or any(not isinstance(item.get(k, {}), dict) for k in ("metadata", "spec", "status")):
        raise HTTPException(502, "Invalid Kubernetes resource response")
    meta, spec, status = (item.get(k, {}) for k in ("metadata", "spec", "status"))
    out = {"name": meta.get("name", ""), "namespace": meta.get("namespace", ""),
           "uid": meta.get("uid", ""), "created": meta.get("creationTimestamp")}
    if resource == "nodes":
        out.update(conditions=status.get("conditions", []), capacity=status.get("capacity", {}),
                   allocatable=status.get("allocatable", {}), addresses=status.get("addresses", []),
                   vm_id=cluster.get("node_vm_map", {}).get(out["name"]),
                   provider_id=spec.get("providerID"), unschedulable=spec.get("unschedulable", False))
    elif resource == "pods":
        containers = []
        for field, kind in (("containerStatuses", "container"), ("initContainerStatuses", "init"),
                            ("ephemeralContainerStatuses", "ephemeral")):
            for c in status.get(field, []):
                containers.append({k: c.get(k) for k in ("name", "image", "ready", "restartCount", "state", "lastState")} | {"kind": kind})
        out.update(phase=status.get("phase", "Unknown"), node=spec.get("nodeName"),
                   containers=containers, conditions=status.get("conditions", []),
                   owners=meta.get("ownerReferences", []),
                   resources=[{"name": c.get("name"), "requests": c.get("resources", {}).get("requests", {}),
                               "limits": c.get("resources", {}).get("limits", {})} for c in spec.get("containers", [])])
    elif resource == "secrets":
        out.update(type=item.get("type"), keys=sorted(item.get("data", {}).keys()))
    elif resource == "configmaps":
        out.update(data=item.get("data", {}), binary_keys=sorted(item.get("binaryData", {}).keys()))
    elif resource == "events":
        out.update({k: item.get(k) for k in ("type", "reason", "message", "count", "lastTimestamp", "involvedObject")})
    elif resource in ("roles", "clusterroles"):
        out.update(rules=item.get("rules", []), aggregation_rule=item.get("aggregationRule"))
    elif resource in ("rolebindings", "clusterrolebindings"):
        out.update(subjects=item.get("subjects", []), role_ref=item.get("roleRef", {}))
    elif resource in ("podmetrics", "nodemetrics"):
        out.update({k: item.get(k) for k in ("timestamp", "window", "usage", "containers")})
    else:
        out.update(status=status, desired_replicas=spec.get("replicas"), schedule=spec.get("schedule"),
                   suspend=spec.get("suspend"), completions=spec.get("completions"))
    return out


def demo_items(resource, namespace):
    def obj(n, **extra):
        return {"metadata": {"name": n, "namespace": namespace, "uid": "demo-" + n}, **extra}
    if resource == "nodes":
        return [obj(n, status={"conditions": [{"type": "Ready", "status": "True"}],
                               "capacity": {"cpu": "4", "memory": "8Gi"},
                               "allocatable": {"cpu": "3900m", "memory": "7Gi"}})
                for n in ("control-plane", "worker-1", "worker-2")]
    if resource == "pods":
        return [obj(n, spec={"nodeName": node, "containers": [{"name": "app"}]},
                    status={"phase": "Running", "containerStatuses": [{"name": "app", "image": "demo/" + n,
                            "ready": True, "restartCount": 0, "state": {"running": {}}}]})
                for n, node in (("document-search", "worker-1"), ("document-parser", "worker-1"),
                                ("embedding", "worker-2"), ("portal", "worker-2"))]
    if resource == "deployments":
        return [obj("document-search", spec={"replicas": 1}, status={"replicas": 1, "readyReplicas": 1})]
    if resource == "events":
        return [obj("scheduled", type="Normal", reason="Scheduled", message="Demo Pod scheduled",
                    involvedObject={"kind": "Pod", "name": "document-search", "namespace": namespace})]
    if resource == "configmaps":
        return [obj("portal-config", data={"APP_MODE": "demo"})]
    if resource == "secrets":
        return [obj("registry-credentials", type="Opaque", data={"token": "never-return-this"})]
    return []


def router(session, audit):
    api = APIRouter(prefix="/api/kubernetes", tags=["Kubernetes"])

    def available(s):
        if s.get("demo"):
            return [{"id": "demo", "name": "Demo Kubernetes", "demo": True,
                     "node_vm_map": {"control-plane": "v1", "worker-1": "v2", "worker-2": "v3"},
                     "users": {s["username"]: {"namespaces": ["default"], "cluster_resources": True,
                               "logs": True, "configmaps": True, "secrets": True, "rbac": True}}}]
        return [c for c in configurations() if s["username"] in c["users"]]

    def authorize(req, cluster_id, namespace=None, resource=None):
        s = session(req)
        c = next((c for c in available(s) if c["id"] == cluster_id), None)
        if c is None:
            raise HTTPException(404, "Cluster not found or not authorized")
        access = c["users"][s["username"]]
        if namespace is not None and name(namespace) not in access["namespaces"]:
            raise HTTPException(403, "Namespace access denied")
        if resource in CLUSTER_RESOURCES and not access.get("cluster_resources", False):
            raise HTTPException(403, "Cluster resource access denied")
        permission = "rbac" if resource in ("roles", "rolebindings", "clusterroles", "clusterrolebindings") else resource
        if permission in ("rbac", "logs", "configmaps", "secrets") and not access.get(permission, False):
            raise HTTPException(403, "Resource access denied")
        return s, c

    @api.get("/clusters")
    def clusters(request: Request):
        s = session(request)
        return {"items": [{"id": c["id"], "name": c.get("name", c["id"]),
                           "demo": c.get("demo", False), "access": c["users"][s["username"]]}
                          for c in available(s)], "read_only": True}

    async def listing(request, cluster_id, resource, namespace, cursor, node=""):
        if node:
            name(node)
            if resource != "pods":
                raise HTTPException(422, "Node filter is only supported for Pods")
        s, c = authorize(request, cluster_id, namespace, resource)
        if resource not in (RESOURCES if namespace is not None else CLUSTER_RESOURCES):
            raise HTTPException(404, "Unsupported resource")
        metrics = resource in ("podmetrics", "nodemetrics")
        if c.get("demo"):
            raw = {"items": demo_items(resource, namespace or "")}
            if node:
                raw["items"] = [i for i in raw["items"] if i.get("spec", {}).get("nodeName") == node]
            if metrics:
                return {"items": [], "continue": "", "available": False, "demo": True}
        else:
            path = CLUSTER_RESOURCES.get(resource) if namespace is None else (
                RESOURCES[resource] + "/namespaces/" + name(namespace) + "/" + ("pods" if resource == "podmetrics" else resource))
            params = {} if metrics else {"limit": 100, "continue": cursor}
            if node:
                params["fieldSelector"] = "spec.nodeName=" + node
            try:
                raw = await fetch(c, path, params)
            except HTTPException as exc:
                if metrics and exc.status_code == 404:
                    return {"items": [], "continue": "", "available": False}
                raise
        if not isinstance(raw, dict) or not isinstance(raw.get("items"), list):
            raise HTTPException(502, "Invalid Kubernetes list response")
        if resource in ("secrets", "configmaps"):
            audit("kubernetes.read." + resource, s["username"], "success", cluster=cluster_id, namespace=namespace)
        return {"items": [project(i, resource, c) for i in raw["items"]],
                "continue": raw.get("metadata", {}).get("continue", ""), "available": True,
                "demo": c.get("demo", False)}

    @api.get("/clusters/{cluster_id}/resources/{resource}")
    async def cluster_list(request: Request, cluster_id: str, resource: str,
                           cursor: str = Query("", max_length=4096)):
        return await listing(request, cluster_id, resource, None, cursor)

    @api.get("/clusters/{cluster_id}/namespaces/{namespace}/resources/{resource}")
    async def namespaced_list(request: Request, cluster_id: str, namespace: str, resource: str,
                              cursor: str = Query("", max_length=4096),
                              node: str = Query("", max_length=253)):
        return await listing(request, cluster_id, resource, namespace, cursor, node)

    @api.get("/clusters/{cluster_id}/namespaces/{namespace}/pods/{pod}/logs")
    async def logs(request: Request, cluster_id: str, namespace: str, pod: str,
                   container: str, previous: bool = False,
                   tail_lines: int = Query(200, ge=1, le=1000),
                   since_seconds: int = Query(3600, ge=1, le=86400)):
        s, c = authorize(request, cluster_id, namespace, "logs")
        name(pod)
        name(container)
        # Audit the attempt before retrieving potentially sensitive workload logs.
        audit("kubernetes.logs", s["username"], "requested", cluster=cluster_id,
              namespace=namespace, pod=pod, container=container, previous=previous)
        if c.get("demo"):
            if pod not in {i["metadata"]["name"] for i in demo_items("pods", namespace)} or container != "app":
                raise HTTPException(404, "Demo Pod or container not found")
            content = "Demo log: service ready; no live workload connected."
        else:
            content = await fetch(c, f"/api/v1/namespaces/{namespace}/pods/{pod}/log",
                                  {"container": container, "previous": str(previous).lower(),
                                   "tailLines": tail_lines, "sinceSeconds": since_seconds,
                                   "limitBytes": 65536, "timestamps": "true"}, text=True)
        return {"text": content, "limit_bytes": 65536, "demo": c.get("demo", False)}

    return api
