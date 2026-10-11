import React, { useEffect, useState } from "react";
import "./kubernetes.css";
import { Details, Status } from "./ui";
import { Box, Search, RefreshCw } from "lucide-react";

type Access = {
  namespaces: string[];
  cluster_resources?: boolean;
  logs?: boolean;
  configmaps?: boolean;
  secrets?: boolean;
  rbac?: boolean;
};
type Cluster = { id: string; name: string; demo: boolean; access: Access };
type Container = {
  name: string;
  ready: boolean;
  restartCount: number;
  state: Record<string, unknown>;
  kind: string;
};
type Row = {
  name: string;
  namespace?: string;
  node?: string;
  vm_id?: string;
  phase?: string;
  containers?: Container[];
  [key: string]: unknown;
};
type Result = { items: Row[]; continue: string; available: boolean };
type VM = { id: string; name?: string; host?: { id: string } };
const clusterResources = new Set([
  "nodes",
  "nodemetrics",
  "clusterroles",
  "clusterrolebindings",
]);
const options = [
  ["nodes", "노드"],
  ["pods", "Pod · 컨테이너"],
  ["deployments", "Deployment"],
  ["statefulsets", "StatefulSet"],
  ["daemonsets", "DaemonSet"],
  ["jobs", "Job"],
  ["cronjobs", "CronJob"],
  ["events", "이벤트"],
  ["configmaps", "ConfigMap"],
  ["secrets", "Secret 메타데이터"],
  ["roles", "Role"],
  ["rolebindings", "RoleBinding"],
  ["clusterroles", "ClusterRole"],
  ["clusterrolebindings", "ClusterRoleBinding"],
  ["podmetrics", "Pod CPU · 메모리"],
  ["nodemetrics", "Node CPU · 메모리"],
];
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/kubernetes" + path, {
    credentials: "same-origin",
    signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
  return body;
}
function summary(row: Row, resource: string): string {
  if (resource === "pods")
    return `${row.phase} · Ready ${(row.containers || []).filter((c) => c.kind === "container" && c.ready).length}/${(row.containers || []).filter((c) => c.kind === "container").length} · 재시작 ${(row.containers || []).reduce((n, c) => n + (c.restartCount || 0), 0)}`;
  if (resource === "nodes") {
    const conditions = row.conditions as
      | { type: string; status: string }[]
      | undefined;
    return (
      "Ready: " +
      (conditions?.find((c) => c.type === "Ready")?.status || "Unknown")
    );
  }
  if (resource === "events")
    return `${row.type || ""} ${row.reason || ""}: ${row.message || ""}`;
  if (resource === "secrets")
    return `값 비공개 · 키: ${((row.keys as string[]) || []).join(", ")}`;
  if (resource === "configmaps")
    return `키: ${Object.keys((row.data as object) || {}).join(", ")}`;
  if (resource === "nodemetrics") return JSON.stringify(row.usage);
  if (resource === "podmetrics") return JSON.stringify(row.containers);
  const status = row.status as Record<string, unknown> | undefined;
  if (status)
    return `준비 ${status.readyReplicas ?? "—"} / 희망 ${row.desired_replicas ?? "—"} · 활성 ${status.active ?? "—"} · 성공 ${status.succeeded ?? "—"}`;
  if (row.role_ref)
    return `Role: ${(row.role_ref as { name?: string }).name || "—"}`;
  if (row.rules) return `규칙 ${(row.rules as unknown[]).length}개`;
  return "상세 보기";
}
export default function Kubernetes({
  vms,
  openVm,
  close,
}: {
  vms: VM[];
  openVm: (id: string) => void;
  close: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [clusters, setClusters] = useState<Cluster[]>([]),
    [clusterId, setClusterId] = useState("");
  const [namespace, setNamespace] = useState(""),
    [resource, setResource] = useState("pods");
  const [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [nodeFilter, setNodeFilter] = useState("");
  const [cursor, setCursor] = useState(""),
    [revision, setRevision] = useState(0),
    [detail, setDetail] = useState<Row | null>(null);
  const [container, setContainer] = useState(""),
    [previous, setPrevious] = useState(false),
    [logs, setLogs] = useState("");
  const [logRevision, setLogRevision] = useState(0),
    [logBusy, setLogBusy] = useState(false),
    [logError, setLogError] = useState("");
  const cluster = clusters.find((c) => c.id === clusterId);
  const allowed = options.filter(([key]) => {
    const a = cluster?.access;
    if (!a) return false;
    if (clusterResources.has(key) && !a.cluster_resources) return false;
    if (
      ["roles", "rolebindings", "clusterroles", "clusterrolebindings"].includes(
        key,
      ) &&
      !a.rbac
    )
      return false;
    if (
      (key === "configmaps" && !a.configmaps) ||
      (key === "secrets" && !a.secrets)
    )
      return false;
    return clusterResources.has(key) || a.namespaces.length > 0;
  });
  useEffect(() => {
    const controller = new AbortController();
    get<{ items: Cluster[] }>("/clusters", controller.signal)
      .then((data) => {
        setClusters(data.items);
        const c = data.items[0];
        if (c) {
          setNodeFilter("");
          setClusterId(c.id);
          setNamespace(c.access.namespaces[0] || "");
          setResource(c.access.namespaces.length ? "pods" : "nodes");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setDetail(null);
    setLogs("");
    setLogRevision(0);
    setResult(null);
    setFilter("");
    if (!clusterId || (!clusterResources.has(resource) && !namespace)) return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    const base = "/clusters/" + encodeURIComponent(clusterId);
    const scope = clusterResources.has(resource)
      ? ""
      : "/namespaces/" + encodeURIComponent(namespace);
    get<Result>(
      `${base}${scope}/resources/${resource}?cursor=${encodeURIComponent(cursor)}${resource === "pods" && nodeFilter ? "&node=" + encodeURIComponent(nodeFilter) : ""}`,
      controller.signal,
    )
      .then(setResult)
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [clusterId, namespace, resource, cursor, revision, nodeFilter]);
  useEffect(() => {
    setLogs("");
    setLogError("");
    setLogBusy(false);
    if (!logRevision || !detail || resource !== "pods" || !container) return;
    const controller = new AbortController();
    setLogBusy(true);
    get<{ text: string }>(
      `/clusters/${encodeURIComponent(clusterId)}/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(detail.name)}/logs?container=${encodeURIComponent(container)}&previous=${previous}`,
      controller.signal,
    )
      .then((r) => setLogs(r.text))
      .catch((e) => {
        if (!controller.signal.aborted) setLogError(String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLogBusy(false);
      });
    return () => controller.abort();
  }, [
    logRevision,
    detail,
    container,
    previous,
    clusterId,
    namespace,
    resource,
  ]);
  const choose = (row: Row) => {
    setLogRevision(0);
    setDetail(row);
    setContainer(row.containers?.[0]?.name || "");
    setPrevious(false);
  };
  return (
    <div className="kubernetes">
      <div className="kube-heading">
        <h1>
          <Box size={20} /> Kubernetes
        </h1>
        <button onClick={close}>가상화 요약으로</button>
      </div>
      <p className="notice">
        조회 전용 · 변경, exec, VM 종료 및 drain은 지원하지 않습니다.{" "}
        {cluster?.demo ? "현재 샘플 데이터입니다." : ""}
      </p>
      <div className="kube-layout">
        <nav className="kube-resource-nav" aria-label="Kubernetes 관리 대상">
          <div className="pane-heading">클러스터 리소스</div>
          {allowed.map(([key, label]) => (
            <button
              key={key}
              className={resource === key ? "active" : ""}
              onClick={() => {
                setResource(key);
                setCursor("");
                setNodeFilter("");
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="kube-main">
          <div className="kube-controls">
            <label>
              클러스터
              <select
                aria-label="클러스터"
                value={clusterId}
                onChange={(e) => {
                  const c = clusters.find((c) => c.id === e.target.value)!;
                  setNodeFilter("");
                  setClusterId(c.id);
                  setNamespace(c.access.namespaces[0] || "");
                  setResource(c.access.namespaces.length ? "pods" : "nodes");
                  setCursor("");
                }}
              >
                {clusters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              네임스페이스
              <select
                aria-label="네임스페이스"
                disabled={clusterResources.has(resource)}
                value={namespace}
                onChange={(e) => {
                  setNamespace(e.target.value);
                  setCursor("");
                }}
              >
                {cluster?.access.namespaces.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label>
              관리 대상
              <select
                aria-label="관리 대상"
                value={resource}
                onChange={(e) => {
                  setResource(e.target.value);
                  setCursor("");
                  setNodeFilter("");
                }}
              >
                {allowed.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={busy || !cluster}
              onClick={() => {
                setCursor("");
                setRevision((n) => n + 1);
              }}
            >
              <RefreshCw size={13} />
              새로 고침
            </button>
          </div>
          {!clusters.length && !error && (
            <p>
              접근 가능한 클러스터가 없습니다. 관리자가 클러스터와 사용자 권한을
              등록해야 합니다.
            </p>
          )}
          {nodeFilter && resource === "pods" && (
            <p>
              노드 필터: {nodeFilter}{" "}
              <button
                onClick={() => {
                  setNodeFilter("");
                  setCursor("");
                }}
              >
                필터 해제
              </button>
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {busy && <p role="status">조회 중…</p>}
          {result && !result.available && (
            <p>
              메트릭 API가 제공되지 않습니다. Metrics Server 설치 및 API 제공
              상태를 확인하세요.
            </p>
          )}
          {result?.available && (
            <>
              <div className="kube-stats">
                <div>
                  <span>조회된 항목</span>
                  <strong>{result.items.length}</strong>
                </div>
                <div>
                  <span>현재 범위</span>
                  <strong>
                    {clusterResources.has(resource) ? "클러스터" : namespace}
                  </strong>
                </div>
                <div>
                  <span>접근 모드</span>
                  <strong>{cluster?.demo ? "데모" : "조회 전용"}</strong>
                </div>
              </div>
              <div className="filter-bar">
                <Search size={14} />
                <input
                  aria-label="Kubernetes 현재 페이지 검색"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="현재 페이지 이름 검색"
                />
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>이름</th>
                      <th>상태 · 상세 요약</th>
                      <th>노드 / VM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items
                      .filter((row) =>
                        row.name.toLowerCase().includes(filter.toLowerCase()),
                      )
                      .map((row) => (
                        <tr
                          key={row.name}
                          className={
                            detail?.name === row.name ? "selected" : ""
                          }
                        >
                          <td>
                            <button onClick={() => choose(row)}>
                              {row.name}
                            </button>
                          </td>
                          <td>
                            {resource === "pods" && (
                              <Status value={row.phase} />
                            )}{" "}
                            {summary(row, resource)}
                          </td>
                          <td>
                            {row.node || ""}
                            {row.vm_id && (
                              <>
                                <span> VM: </span>
                                {vms.some((v) => v.id === row.vm_id) ? (
                                  <button onClick={() => openVm(row.vm_id!)}>
                                    {vms.find((v) => v.id === row.vm_id)
                                      ?.name || row.vm_id}
                                  </button>
                                ) : (
                                  <span>{row.vm_id} (현재 VM 목록에 없음)</span>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {!result.items.length && <p>조회된 항목이 없습니다.</p>}
              <div className="kube-controls">
                <button
                  disabled={!cursor || busy}
                  onClick={() => setCursor("")}
                >
                  첫 페이지
                </button>
                <button
                  disabled={!result.continue || busy}
                  onClick={() => setCursor(result.continue)}
                >
                  다음 페이지
                </button>
                <span>
                  일반 목록은 페이지당 최대 100개 요청 · 메트릭은 API 응답 범위
                </span>
              </div>
            </>
          )}
          {detail && (
            <section className="kube-detail panel">
              <div className="panel-heading">
                <h2>{detail.name}</h2>
                <button onClick={() => setDetail(null)}>상세 닫기</button>
              </div>
              <div className="panel-content">
                {resource === "nodes" && namespace && (
                  <button
                    onClick={() => {
                      setNodeFilter(detail.name);
                      setResource("pods");
                      setCursor("");
                    }}
                  >
                    이 노드의 Pod 조회 (선택한 네임스페이스)
                  </button>
                )}
                <Details value={detail} />
                <details className="raw-data">
                  <summary>JSON 보기</summary>
                  <pre>{JSON.stringify(detail, null, 2)}</pre>
                </details>
                {resource === "pods" && cluster?.access.logs && (
                  <>
                    <h3>컨테이너 로그</h3>
                    <div className="kube-controls">
                      <label>
                        컨테이너
                        <select
                          value={container}
                          onChange={(e) => {
                            setContainer(e.target.value);
                            setLogRevision(0);
                          }}
                        >
                          {detail.containers?.map((c) => (
                            <option key={c.name}>{c.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={previous}
                          onChange={(e) => {
                            setPrevious(e.target.checked);
                            setLogRevision(0);
                          }}
                        />{" "}
                        이전 컨테이너
                      </label>
                      <button
                        disabled={!container || logBusy}
                        onClick={() => setLogRevision((n) => n + 1)}
                      >
                        로그 조회
                      </button>
                    </div>
                    <p>
                      최근 1시간, 최대 200줄 / 64 KiB. 민감 정보가 포함될 수
                      있습니다.
                    </p>
                    {logError && <p role="alert">{logError}</p>}
                    {logBusy ? <p>로그 조회 중…</p> : <pre>{logs}</pre>}
                  </>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
