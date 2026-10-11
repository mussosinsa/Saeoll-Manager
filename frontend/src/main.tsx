import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Server,
  LayoutDashboard,
  Monitor,
  HardDrive,
  Network,
  Activity,
  LogOut,
  RefreshCw,
  Search,
  ChevronDown,
  ChevronRight,
  Settings,
  Power,
  Info,
  ShieldCheck,
  Layers,
  Box,
  BookOpen,
  PanelBottomClose,
  PanelBottomOpen,
} from "lucide-react";
import Kubernetes from "./Kubernetes";
import { Panel, Status, Details, Modal } from "./ui";
import "./style.css";

type Resource =
  | "datacenters"
  | "clusters"
  | "hosts"
  | "vms"
  | "storagedomains"
  | "networks"
  | "events";
type Item = {
  id: string;
  name?: string;
  status?: string;
  description?: string;
  memory?: number;
  cpu?: { topology?: { cores?: number; sockets?: number; threads?: number } };
  cluster?: { id: string };
  host?: { id: string };
  data_center?: { id: string };
  [key: string]: unknown;
};
type Auth = {
  username: string;
  csrf: string;
  demo: boolean;
  writes_enabled: boolean;
};
type Selection = { resource: Resource; id: string } | null;
type Preferences = {
  density: "compact" | "comfortable";
  refresh: number;
  events: boolean;
};
type RequestLog = { id: number; time: string; action: string; status: string };
const resources: Resource[] = [
  "datacenters",
  "clusters",
  "hosts",
  "vms",
  "storagedomains",
  "networks",
  "events",
];
const labels: Record<Resource, string> = {
  datacenters: "데이터센터",
  clusters: "클러스터",
  hosts: "물리 호스트",
  vms: "가상 머신",
  storagedomains: "스토리지",
  networks: "네트워크",
  events: "Engine 이벤트",
};
const icons: Record<Resource, React.ReactNode> = {
  datacenters: <Layers size={15} />,
  clusters: <Network size={15} />,
  hosts: <Server size={15} />,
  vms: <Monitor size={15} />,
  storagedomains: <HardDrive size={15} />,
  networks: <Network size={15} />,
  events: <Activity size={15} />,
};
const empty: Record<Resource, Item[]> = {
  datacenters: [],
  clusters: [],
  hosts: [],
  vms: [],
  storagedomains: [],
  networks: [],
  events: [],
};
const defaults: Preferences = { density: "compact", refresh: 30, events: true };
function readPreference(): Preferences {
  try {
    const v = JSON.parse(localStorage.getItem("ovworks.ui") || "{}");
    return {
      density: v.density === "comfortable" ? "comfortable" : "compact",
      refresh: [0, 30, 60, 120].includes(v.refresh) ? v.refresh : 30,
      events: typeof v.events === "boolean" ? v.events : true,
    };
  } catch {
    return defaults;
  }
}
function remembered() {
  try {
    return localStorage.getItem("ovworks.username") || "";
  } catch {
    return "";
  }
}
function title(item: Item) {
  return item.name || item.description || item.id;
}
function memory(value: unknown) {
  if (value === undefined || value === null || value === "") return "미제공";
  const n = Number(value);
  return Number.isFinite(n) && n >= 0
    ? `${(n / 1073741824).toLocaleString("ko-KR", { maximumFractionDigits: 1 })} GiB`
    : "미제공";
}
async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch("/api" + path, { credentials: "same-origin", ...opts });
  const data = await r.json().catch(() => ({ detail: r.statusText }));
  if (!r.ok)
    throw Error(
      typeof data.detail === "string" ? data.detail : `HTTP ${r.status}`,
    );
  return data;
}

function App() {
  const [auth, setAuth] = useState<Auth | null>(null),
    [username, setUsername] = useState(remembered),
    [password, setPassword] = useState(""),
    [remember, setRemember] = useState(() => !!remembered());
  const [booting, setBooting] = useState(true),
    [loggingIn, setLoggingIn] = useState(false),
    [loginError, setLoginError] = useState(""),
    [preferences, setPreferences] = useState(readPreference);
  const [settings, setSettings] = useState(false),
    [help, setHelp] = useState(false),
    [inventory, setInventory] = useState(empty),
    [errors, setErrors] = useState<Partial<Record<Resource, string>>>({});
  const [loading, setLoading] = useState(false),
    [updated, setUpdated] = useState(""),
    [tab, setTab] = useState<Resource | "dashboard" | "search" | "kubernetes">(
      "dashboard",
    );
  const [selection, setSelection] = useState<Selection>(null),
    [detailTab, setDetailTab] = useState("Summary"),
    [query, setQuery] = useState(""),
    [treeQuery, setTreeQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}),
    [logs, setLogs] = useState<RequestLog[]>([]),
    [bottomTab, setBottomTab] = useState<"events" | "requests">("events");
  const [page, setPage] = useState(1),
    [pageItems, setPageItems] = useState<Item[]>([]),
    [pageMore, setPageMore] = useState(false),
    [pageBusy, setPageBusy] = useState(false),
    [pageError, setPageError] = useState("");
  const [children, setChildren] = useState<Item[]>([]),
    [detailError, setDetailError] = useState(""),
    [detailBusy, setDetailBusy] = useState(false),
    [engine, setEngine] = useState("미확인"),
    [engineBusy, setEngineBusy] = useState(false);
  const [revision, setRevision] = useState(0),
    [notice, setNotice] = useState("");
  const loadController = useRef<AbortController | null>(null),
    serial = useRef(0);
  const selected = selection
    ? inventory[selection.resource].find((i) => i.id === selection.id)
    : undefined;
  const record = useCallback(
    (action: string, status: string) =>
      setLogs((old) =>
        [
          {
            id: ++serial.current,
            time: new Date().toLocaleTimeString("ko-KR"),
            action,
            status,
          },
          ...old,
        ].slice(0, 100),
      ),
    [],
  );
  useEffect(() => {
    try {
      localStorage.setItem("ovworks.ui", JSON.stringify(preferences));
    } catch {}
  }, [preferences]);
  useEffect(() => {
    const controller = new AbortController();
    api<Auth>("/auth/me", { signal: controller.signal })
      .then(setAuth)
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setBooting(false);
      });
    return () => controller.abort();
  }, []);
  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    const results = await Promise.allSettled(
      resources.map((r) =>
        api<{ items: Item[] }>("/inventory/" + r, {
          signal: controller.signal,
        }),
      ),
    );
    if (controller.signal.aborted) return;
    const nextErrors: Partial<Record<Resource, string>> = {};
    const next = { ...empty };
    resources.forEach((r, i) => {
      const result = results[i];
      if (result.status === "fulfilled") next[r] = result.value.items;
      else nextErrors[r] = String(result.reason);
    });
    setInventory(next);
    setErrors(nextErrors);
    setUpdated(new Date().toLocaleTimeString("ko-KR"));
    setLoading(false);
    record(
      "Engine 인벤토리 조회",
      Object.keys(nextErrors).length ? "error" : "success",
    );
  }, [record]);
  useEffect(() => {
    if (!auth) return;
    load();
    const timer = preferences.refresh
      ? window.setInterval(load, preferences.refresh * 1000)
      : undefined;
    return () => {
      if (timer) clearInterval(timer);
      loadController.current?.abort();
    };
  }, [auth, load, preferences.refresh, revision]);
  useEffect(() => {
    setPage(1);
  }, [tab]);
  useEffect(() => {
    setPageItems([]);
    setPageError("");
    setPageMore(false);
    setPageBusy(false);
    if (!auth || selection || !resources.includes(tab as Resource)) return;
    const controller = new AbortController();
    setPageBusy(true);
    api<{ items: Item[]; has_more: boolean }>(
      `/inventory/${tab}/page?page=${page}&page_size=50`,
      { signal: controller.signal },
    )
      .then((d) => {
        setPageItems(d.items);
        setPageMore(d.has_more);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setPageError(String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPageBusy(false);
      });
    return () => controller.abort();
  }, [auth, tab, selection, page, updated]);
  useEffect(() => {
    setChildren([]);
    setDetailError("");
    setDetailBusy(false);
    if (!auth || selection?.resource !== "vms" || detailTab === "Summary")
      return;
    const paths: Record<string, string> = {
      Disks: "diskattachments",
      NICs: "nics",
      Snapshots: "snapshots",
      Console: "graphicsconsoles",
    };
    if (!paths[detailTab]) return;
    const controller = new AbortController();
    setDetailBusy(true);
    api<{ items: Item[] }>(
      `/vms/${encodeURIComponent(selection.id)}/${paths[detailTab]}`,
      { signal: controller.signal },
    )
      .then((d) => setChildren(d.items))
      .catch((e) => {
        if (!controller.signal.aborted) setDetailError(String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailBusy(false);
      });
    return () => controller.abort();
  }, [auth, selection, detailTab, updated]);
  const navigate = (next: typeof tab) => {
    setQuery("");
    setTab(next);
    setSelection(null);
    setDetailTab("Summary");
  };
  const pick = (resource: Resource, item: Item) => {
    setTab(resource);
    setSelection({ resource, id: item.id });
    setDetailTab("Summary");
  };
  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError("");
    try {
      const a = await api<Auth>("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      try {
        if (remember) localStorage.setItem("ovworks.username", username);
        else localStorage.removeItem("ovworks.username");
      } catch {}
      setAuth(a);
      setPassword("");
    } catch (e) {
      setLoginError(String(e));
    } finally {
      setLoggingIn(false);
    }
  };
  const logout = async () => {
    if (!auth) return;
    setNotice("");
    try {
      await api("/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": auth.csrf },
      });
      loadController.current?.abort();
      setAuth(null);
      setInventory(empty);
      setLogs([]);
      setSelection(null);
      setTab("dashboard");
      setQuery("");
      setEngine("미확인");
    } catch (e) {
      setNotice("로그아웃 실패: " + String(e));
    }
  };
  const checkEngine = async () => {
    setEngineBusy(true);
    try {
      const d = await api<{ engine_connected: boolean }>("/health/engine");
      setEngine(d.engine_connected ? "연결됨" : "데모 · 미연결");
      record("Engine 연결 확인", "success");
    } catch (e) {
      setEngine(String(e));
      record("Engine 연결 확인", "error");
    } finally {
      setEngineBusy(false);
    }
  };
  const toggle = (id: string) =>
    setCollapsed((old) => ({ ...old, [id]: !old[id] }));
  const matches = (item: Item) =>
    `${title(item)} ${item.id}`.toLowerCase().includes(treeQuery.toLowerCase());
  const leaf = (resource: Resource, item: Item, depth = 0) => (
    <button
      className={
        "tree-row " +
        (selection?.resource === resource && selection.id === item.id
          ? "selected"
          : "")
      }
      style={{ paddingLeft: 12 + depth * 16 }}
      key={resource + item.id}
      onClick={() => pick(resource, item)}
      title={title(item)}
    >
      {icons[resource]}
      <span
        className={
          "tiny-dot " +
          (item.status === "up" || item.status === "active" ? "online" : "")
        }
      />
      <span>{title(item)}</span>
    </button>
  );
  const branch = (
    key: string,
    label: string,
    depth: number,
    content: React.ReactNode,
    icon: React.ReactNode,
    target?: { resource: Resource; item: Item },
  ) => (
    <React.Fragment key={key}>
      <div
        className={
          "tree-row tree-branch " +
          (target &&
          selection?.resource === target.resource &&
          selection.id === target.item.id
            ? "selected"
            : "")
        }
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <button
          className="tree-toggle"
          aria-label={label + " 하위 항목 펼치기/접기"}
          aria-expanded={!collapsed[key]}
          onClick={() => toggle(key)}
        >
          {collapsed[key] ? (
            <ChevronRight size={12} />
          ) : (
            <ChevronDown size={12} />
          )}
        </button>
        <button
          className="tree-target"
          onClick={() =>
            target ? pick(target.resource, target.item) : toggle(key)
          }
        >
          {icon}
          <span>{label}</span>
        </button>
      </div>
      {(!collapsed[key] || treeQuery) && content}
    </React.Fragment>
  );
  const hostTree = (host: Item, depth: number) =>
    branch(
      "host-" + host.id,
      title(host),
      depth,
      <>
        {inventory.vms
          .filter((v) => v.host?.id === host.id && matches(v))
          .map((v) => leaf("vms", v, depth + 1))}
      </>,
      <Server size={14} />,
      { resource: "hosts", item: host },
    );
  const tree = treeQuery ? (
    <>
      {resources
        .filter((r) => r !== "events")
        .flatMap((r) => inventory[r].filter(matches).map((i) => leaf(r, i)))}
    </>
  ) : (
    <>
      {inventory.datacenters.map((dc) =>
        branch(
          "dc-" + dc.id,
          title(dc),
          0,
          <>
            {inventory.clusters
              .filter((c) => c.data_center?.id === dc.id)
              .map((c) =>
                branch(
                  "cluster-" + c.id,
                  title(c),
                  1,
                  <>
                    {inventory.hosts
                      .filter((h) => h.cluster?.id === c.id)
                      .map((h) => hostTree(h, 2))}
                    {inventory.vms
                      .filter(
                        (v) =>
                          v.cluster?.id === c.id &&
                          !inventory.hosts.some((h) => h.id === v.host?.id),
                      )
                      .map((v) => leaf("vms", v, 2))}
                  </>,
                  <Network size={14} />,
                  { resource: "clusters", item: c },
                ),
              )}
          </>,
          <Layers size={14} />,
          { resource: "datacenters", item: dc },
        ),
      )}
      {inventory.clusters
        .filter(
          (c) => !inventory.datacenters.some((d) => d.id === c.data_center?.id),
        )
        .map((c) =>
          branch(
            "cluster-" + c.id,
            title(c),
            0,
            <>
              {inventory.hosts
                .filter((h) => h.cluster?.id === c.id)
                .map((h) => hostTree(h, 1))}
            </>,
            <Network size={14} />,
            { resource: "clusters", item: c },
          ),
        )}
      {inventory.hosts
        .filter((h) => !inventory.clusters.some((c) => c.id === h.cluster?.id))
        .map((h) => hostTree(h, 0))}
      {branch(
        "all-vms",
        "전체 가상 머신",
        0,
        inventory.vms.map((v) => leaf("vms", v, 1)),
        <Monitor size={14} />,
      )}
      {branch(
        "storage",
        "스토리지",
        0,
        inventory.storagedomains.map((i) => leaf("storagedomains", i, 1)),
        <HardDrive size={14} />,
      )}
    </>
  );
  const table = (items: Item[], resource: Resource) => (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>이름 / 설명</th>
            <th>상태</th>
            {resource === "vms" && (
              <>
                <th>설정 메모리</th>
                <th>호스트</th>
              </>
            )}
            <th>ID</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              className={selected?.id === item.id ? "selected" : ""}
            >
              <td>
                <button
                  className="link-button"
                  onClick={() => pick(resource, item)}
                >
                  {icons[resource]}
                  {title(item)}
                </button>
              </td>
              <td>
                <Status value={item.status || String(item.type || "")} />
              </td>
              {resource === "vms" && (
                <>
                  <td>{memory(item.memory)}</td>
                  <td>
                    {inventory.hosts.find((h) => h.id === item.host?.id)
                      ?.name || "—"}
                  </td>
                </>
              )}
              <td className="mono muted">{item.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && <div className="empty">표시할 항목이 없습니다.</div>}
    </div>
  );
  const modal = settings ? (
    <Modal title="화면 설정" onClose={() => setSettings(false)}>
      <p>이 브라우저에 적용됩니다. 인증정보는 저장하지 않습니다.</p>
      <label>
        목록 밀도
        <select
          value={preferences.density}
          onChange={(e) =>
            setPreferences((p) => ({
              ...p,
              density: e.target.value as Preferences["density"],
            }))
          }
        >
          <option value="compact">조밀하게</option>
          <option value="comfortable">여유 있게</option>
        </select>
      </label>
      <label>
        Engine 자동 새로 고침
        <select
          value={preferences.refresh}
          onChange={(e) =>
            setPreferences((p) => ({ ...p, refresh: Number(e.target.value) }))
          }
        >
          {[0, 30, 60, 120].map((n) => (
            <option key={n} value={n}>
              {n ? n + "초" : "사용 안 함"}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={preferences.events}
          onChange={(e) =>
            setPreferences((p) => ({ ...p, events: e.target.checked }))
          }
        />{" "}
        하단 이벤트 창 표시
      </label>
      <button onClick={() => setPreferences(defaults)}>기본 설정 복원</button>
    </Modal>
  ) : help ? (
    <Modal title="OV-Works 사용 안내" onClose={() => setHelp(false)}>
      <p>
        왼쪽 서버 트리에서 대상을 선택하고, 보조 메뉴에서
        요약·디스크·NIC·스냅샷을 확인하세요.
      </p>
      <p>
        검색은 현재 조회된 Engine 인벤토리에서 이름과 ID를 찾습니다. Kubernetes
        데이터는 Kubernetes 화면에서 별도로 조회합니다.
      </p>
      <p>
        현재 서비스는 조회 전용입니다. VM 변경과 브라우저 콘솔 연결, 시계열
        모니터링은 제공되지 않습니다.
      </p>
      <p>
        하단의 Engine 이벤트와 이 브라우저의 조회 기록은 서로 다른 정보입니다.
      </p>
      <p>
        운영 연동: 저장소의 docs/kubernetes.md 및 deploy 설정 예시를 참고하세요.
      </p>
    </Modal>
  ) : null;
  if (booting)
    return (
      <div className="boot-screen" role="status">
        OV-Works · 세션 확인 중…
      </div>
    );
  if (!auth)
    return (
      <div className="login-screen">
        <div className="login-brand">
          <Layers size={30} />
          <strong>OV-Works</strong>
          <span>4.5 Admin</span>
        </div>
        <form className="login-dialog" onSubmit={login}>
          <div className="panel-heading">
            <h1>OV-Works 관리 콘솔 로그인</h1>
            <ShieldCheck size={18} />
          </div>
          <div className="login-fields">
            <label htmlFor="username">사용자 이름</label>
            <input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              autoFocus
            />
            <label htmlFor="password">비밀번호</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <span>인증 방식</span>
            <span className="field-note">서버에 설정된 Engine 인증 / 데모</span>
            <span>언어</span>
            <span className="field-note">한국어</span>
          </div>
          {loginError && (
            <p className="error" role="alert">
              {loginError}
            </p>
          )}
          <div className="login-footer">
            <label>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />{" "}
              사용자 이름 기억
            </label>
            <button className="primary" disabled={loggingIn} type="submit">
              {loggingIn ? "로그인 중…" : "로그인"}
            </button>
          </div>
          <p className="login-note">
            데모 환경에서는 demo / demo로 로그인합니다.
          </p>
        </form>
        <p className="login-caption">
          가상화 인프라와 Kubernetes를 하나의 관리 콘솔에서
        </p>
      </div>
    );
  const failures = Object.entries(errors);
  const up = inventory.vms.filter((v) => v.status === "up").length;
  const heading = selected
    ? title(selected)
    : tab === "dashboard"
      ? "데이터센터 요약"
      : tab === "search"
        ? "자원 검색"
        : tab === "kubernetes"
          ? "Kubernetes 현황"
          : labels[tab];
  return (
    <div
      className={`console ${preferences.density} ${preferences.events ? "with-events" : ""}`}
    >
      <header className="topbar">
        <button
          className="brand"
          onClick={() => navigate("dashboard")}
          aria-label="OV-Works 홈"
        >
          <Layers size={23} />
          <strong>OV-Works</strong>
          <span>4.5 Admin</span>
        </button>
        <form
          className="global-search"
          onSubmit={(e) => {
            e.preventDefault();
            setTab("search");
            setSelection(null);
          }}
        >
          <Search size={15} />
          <input
            aria-label="전체 자원 검색"
            placeholder="자원 이름 또는 ID 검색"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setTab("search");
              setSelection(null);
            }}
          />
        </form>
        <div className="top-actions">
          <span className="mode-badge">
            {auth.demo ? "DEMO" : "ENGINE"} · READ ONLY
          </span>
          <button onClick={() => navigate("kubernetes")}>
            <Box size={15} />
            Kubernetes
          </button>
          <button aria-label="사용 안내" onClick={() => setHelp(true)}>
            <BookOpen size={16} />
          </button>
          <button aria-label="화면 설정" onClick={() => setSettings(true)}>
            <Settings size={16} />
          </button>
          <button onClick={logout} title="로그아웃">
            <LogOut size={15} />
            <span>{auth.username}</span>
          </button>
        </div>
      </header>
      <div className="console-workspace">
        <aside className="server-pane">
          <div className="pane-heading">
            <Server size={14} /> 서버 보기
            <button
              aria-label="서버 트리 접기/펼치기"
              onClick={() =>
                setCollapsed((old) =>
                  Object.keys(old).length
                    ? {}
                    : Object.fromEntries(
                        [
                          "all-vms",
                          "storage",
                          ...inventory.datacenters.map((i) => "dc-" + i.id),
                          ...inventory.clusters.map((i) => "cluster-" + i.id),
                          ...inventory.hosts.map((i) => "host-" + i.id),
                        ].map((k) => [k, true]),
                      ),
                )
              }
            >
              <ChevronDown size={14} />
            </button>
          </div>
          <div className="tree-search">
            <Search size={13} />
            <input
              aria-label="서버 트리 검색"
              placeholder="트리 검색"
              value={treeQuery}
              onChange={(e) => setTreeQuery(e.target.value)}
            />
          </div>
          <button
            className={"tree-row " + (tab === "dashboard" ? "selected" : "")}
            onClick={() => navigate("dashboard")}
          >
            <Layers size={15} />
            <strong>데이터센터</strong>
          </button>
          <div className="tree-content">
            {tree}
            {!loading && !resources.some((r) => inventory[r].length > 0) && (
              <p className="empty">인벤토리가 없습니다.</p>
            )}
          </div>
          <button
            className={
              "tree-row kube-entry " + (tab === "kubernetes" ? "selected" : "")
            }
            onClick={() => navigate("kubernetes")}
          >
            <Box size={15} />
            Kubernetes 클러스터
          </button>
        </aside>
        {tab !== "kubernetes" && (
          <nav className="context-nav" aria-label="자원 메뉴">
            <div className="pane-heading">
              {selection ? labels[selection.resource] : "관리"}
            </div>
            {selection ? (
              <>
                <button
                  className={detailTab === "Summary" ? "active" : ""}
                  onClick={() => setDetailTab("Summary")}
                >
                  <LayoutDashboard size={15} />
                  요약
                </button>
                {selection.resource === "vms" &&
                  [
                    ["Disks", "디스크", <HardDrive size={15} />],
                    ["NICs", "네트워크 인터페이스", <Network size={15} />],
                    ["Snapshots", "스냅샷", <Layers size={15} />],
                    ["Console", "콘솔 정보", <Monitor size={15} />],
                  ].map(([id, label, icon]) => (
                    <button
                      key={String(id)}
                      className={detailTab === id ? "active" : ""}
                      onClick={() => setDetailTab(String(id))}
                    >
                      {icon}
                      {label}
                    </button>
                  ))}
                <button onClick={() => navigate(selection.resource)}>
                  <Search size={15} />
                  목록으로
                </button>
              </>
            ) : (
              <>
                <button
                  className={tab === "dashboard" ? "active" : ""}
                  onClick={() => navigate("dashboard")}
                >
                  <LayoutDashboard size={15} />
                  요약
                </button>
                <button
                  className={tab === "search" ? "active" : ""}
                  onClick={() => navigate("search")}
                >
                  <Search size={15} />
                  검색
                </button>
                {resources.map((r) => (
                  <button
                    key={r}
                    className={tab === r ? "active" : ""}
                    onClick={() => navigate(r)}
                  >
                    {icons[r]}
                    {labels[r]}
                  </button>
                ))}
              </>
            )}
            <div className="nav-divider" />
            <button onClick={() => navigate("kubernetes")}>
              <Box size={15} />
              Kubernetes
            </button>
            <button onClick={() => setSettings(true)}>
              <Settings size={15} />
              화면 설정
            </button>
          </nav>
        )}
        <main className="main-pane">
          <div className="content-toolbar">
            <div className="breadcrumb">
              {selection ? (
                <>
                  <button
                    className="link-button"
                    onClick={() => navigate(selection.resource)}
                  >
                    {labels[selection.resource]}
                  </button>
                  <ChevronRight size={13} />
                </>
              ) : (
                <Layers size={14} />
              )}
              <strong>{heading}</strong>
            </div>
            <div className="toolbar-actions">
              {selection?.resource === "vms" && (
                <>
                  <button
                    disabled
                    title="현재 버전에서는 VM 변경이 비활성화되어 있습니다"
                  >
                    <Power size={13} />
                    시작
                  </button>
                  <button
                    disabled
                    title="현재 버전에서는 VM 변경이 비활성화되어 있습니다"
                  >
                    종료
                  </button>
                </>
              )}
              <button
                disabled={loading}
                onClick={() => setRevision((n) => n + 1)}
                aria-label="Engine 새로 고침"
              >
                <RefreshCw size={13} className={loading ? "spin" : ""} />
                새로 고침
              </button>
            </div>
          </div>
          <div className="content-scroll">
            {notice && (
              <div className="error" role="alert">
                {notice}
              </div>
            )}
            {failures.length > 0 && (
              <div className="error" role="alert">
                조회 실패:{" "}
                {failures.map(([r, e]) => (
                  <div key={r}>
                    {labels[r as Resource]} — {e}
                  </div>
                ))}
              </div>
            )}
            {tab === "kubernetes" ? (
              <Kubernetes
                vms={inventory.vms}
                close={() => navigate("dashboard")}
                openVm={(id) => {
                  const vm = inventory.vms.find((v) => v.id === id);
                  if (vm) pick("vms", vm);
                }}
              />
            ) : selection ? (
              <>
                {!selected ? (
                  <div className="empty">
                    대상을 현재 인벤토리에서 찾을 수 없습니다. 새로 고침하거나
                    목록으로 돌아가세요.
                  </div>
                ) : detailTab === "Summary" ? (
                  <>
                    <div className="summary-grid">
                      <Panel title={title(selected)}>
                        <Details
                          value={{
                            상태: selected.status || "미제공",
                            ID: selected.id,
                            ...(selection.resource === "vms"
                              ? {
                                  "설정 메모리": memory(selected.memory),
                                  "가상 CPU": selected.cpu?.topology
                                    ? Number(selected.cpu.topology.cores || 1) *
                                      Number(
                                        selected.cpu.topology.sockets || 1,
                                      ) *
                                      Number(selected.cpu.topology.threads || 1)
                                    : "미제공",
                                  "물리 호스트":
                                    inventory.hosts.find(
                                      (h) => h.id === selected.host?.id,
                                    )?.name || "미제공",
                                  클러스터:
                                    inventory.clusters.find(
                                      (c) => c.id === selected.cluster?.id,
                                    )?.name || "미제공",
                                }
                              : {}),
                          }}
                        />
                      </Panel>
                      <Panel title="설명 및 운영 상태">
                        <p>
                          {selected.description || "등록된 설명이 없습니다."}
                        </p>
                        <p className="info-note">
                          <ShieldCheck size={16} /> 조회 전용 연결입니다.
                        </p>
                        {selection.resource === "hosts" && (
                          <p>
                            배치된 VM:{" "}
                            {
                              inventory.vms.filter(
                                (v) => v.host?.id === selected.id,
                              ).length
                            }
                            개
                          </p>
                        )}
                        <button onClick={() => navigate("kubernetes")}>
                          <Box size={14} /> Kubernetes 노드 연결 확인
                        </button>
                      </Panel>
                    </div>
                    {selection.resource === "hosts" && (
                      <Panel title="이 호스트의 가상 머신">
                        {table(
                          inventory.vms.filter(
                            (v) => v.host?.id === selected.id,
                          ),
                          "vms",
                        )}
                      </Panel>
                    )}
                    <Panel title="리소스 정보">
                      <Details value={selected} />
                    </Panel>
                    <Panel title="성능 모니터링">
                      <div className="empty">
                        <Activity size={26} />
                        <h3>시계열 데이터 미제공</h3>
                        <p>
                          현재 Engine 조회 API는 CPU·메모리 사용 이력을 제공하지
                          않습니다.
                        </p>
                      </div>
                    </Panel>
                  </>
                ) : (
                  <Panel
                    title={
                      {
                        Disks: "디스크",
                        NICs: "네트워크 인터페이스",
                        Snapshots: "스냅샷",
                        Console: "콘솔 메타데이터",
                      }[detailTab] || detailTab
                    }
                  >
                    {detailTab === "Console" && (
                      <p className="info-note">
                        콘솔 프로토콜 정보만 표시합니다. 브라우저 VNC/SPICE
                        접속은 지원하지 않습니다.
                      </p>
                    )}
                    {detailBusy ? (
                      <p role="status">조회 중…</p>
                    ) : detailError ? (
                      <p role="alert" className="error">
                        {detailError}
                      </p>
                    ) : children.length ? (
                      children.map((item) => (
                        <div key={item.id} className="child-details">
                          <h3>{title(item)}</h3>
                          <Details value={item} />
                        </div>
                      ))
                    ) : (
                      <p className="empty">조회된 항목이 없습니다.</p>
                    )}
                  </Panel>
                )}
              </>
            ) : tab === "dashboard" ? (
              <>
                <Panel
                  title="연결 및 상태"
                  action={
                    <button onClick={checkEngine} disabled={engineBusy}>
                      Engine 연결 확인
                    </button>
                  }
                >
                  <div className="health-grid">
                    <div>
                      <ShieldCheck size={30} />
                      <strong>
                        {auth.demo ? "데모 환경" : "Engine 조회 모드"}
                      </strong>
                      <span>{engine}</span>
                    </div>
                    <div>
                      <Server size={27} />
                      <strong>
                        {errors.hosts
                          ? "—"
                          : inventory.hosts.filter((h) => h.status === "up")
                              .length}{" "}
                        / {errors.hosts ? "—" : inventory.hosts.length}
                      </strong>
                      <span>활성 물리 호스트</span>
                    </div>
                    <div>
                      <Network size={27} />
                      <strong>
                        {errors.clusters ? "—" : inventory.clusters.length}
                      </strong>
                      <span>클러스터</span>
                    </div>
                  </div>
                </Panel>
                <Panel title="가상화 리소스">
                  <div className="resource-cards">
                    {(
                      [
                        "vms",
                        "hosts",
                        "storagedomains",
                        "networks",
                      ] as Resource[]
                    ).map((r, i) => (
                      <button
                        key={r}
                        className={"resource-card color-" + i}
                        onClick={() => navigate(r)}
                      >
                        {icons[r]}
                        <strong>{errors[r] ? "—" : inventory[r].length}</strong>
                        <span>{labels[r]}</span>
                      </button>
                    ))}
                  </div>
                </Panel>
                <div className="summary-grid">
                  <Panel title="가상 머신 실행 상태">
                    <div className="gauge-block">
                      <div
                        className="ring"
                        style={
                          {
                            "--percent":
                              !errors.vms && inventory.vms.length
                                ? `${(up / inventory.vms.length) * 100}%`
                                : "0%",
                          } as React.CSSProperties
                        }
                      >
                        <strong>
                          {errors.vms ? "—" : up}
                          <small>실행 중</small>
                        </strong>
                      </div>
                      <div>
                        <p>
                          <Status value="up" /> {errors.vms ? "—" : up}개
                        </p>
                        <p>
                          <Status value="down" />{" "}
                          {errors.vms
                            ? "—"
                            : inventory.vms.filter((v) => v.status === "down")
                                .length}
                          개
                        </p>
                        <p className="muted">
                          조회된 VM {errors.vms ? "—" : inventory.vms.length}개
                          기준
                        </p>
                      </div>
                    </div>
                  </Panel>
                  <Panel title="컨테이너 플랫폼">
                    <div className="platform-callout">
                      <Box size={36} />
                      <div>
                        <h3>Kubernetes</h3>
                        <p>노드, 워크로드, Pod 상태와 로그를 조회합니다.</p>
                        <button
                          className="primary"
                          onClick={() => navigate("kubernetes")}
                        >
                          Kubernetes 현황 열기
                        </button>
                      </div>
                    </div>
                  </Panel>
                </div>
                <Panel title="물리 호스트">
                  {table(inventory.hosts, "hosts")}
                </Panel>
              </>
            ) : tab === "search" ? (
              <Panel
                title="자원 검색"
                action={
                  <span className="muted">현재 조회된 Engine 인벤토리</span>
                }
              >
                <div className="filter-bar">
                  <Search size={15} />
                  <input
                    aria-label="검색어"
                    placeholder="이름 또는 ID 입력"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                {resources
                  .filter((r) => r !== "events")
                  .map((r) => {
                    const rows = inventory[r].filter((i) =>
                      `${title(i)} ${i.id}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    );
                    return rows.length ? (
                      <section key={r}>
                        <h3 className="list-section-title">
                          {labels[r]} · {rows.length}
                        </h3>
                        {table(rows, r)}
                      </section>
                    ) : null;
                  })}
                {!resources
                  .filter((r) => r !== "events")
                  .some((r) =>
                    inventory[r].some((i) =>
                      `${title(i)} ${i.id}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    ),
                  ) && <p className="empty">검색 결과가 없습니다.</p>}
              </Panel>
            ) : (
              <Panel title={labels[tab]}>
                <div className="filter-bar">
                  <Search size={15} />
                  <input
                    aria-label="현재 페이지 검색"
                    placeholder="현재 페이지 이름 / ID 검색"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <span className="muted">페이지 {page}</span>
                </div>
                {pageBusy ? (
                  <p className="empty" role="status">
                    조회 중…
                  </p>
                ) : pageError ? (
                  <p className="error" role="alert">
                    {pageError}
                  </p>
                ) : (
                  table(
                    pageItems.filter((i) =>
                      `${title(i)} ${i.id}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    ),
                    tab,
                  )
                )}
                <div className="pagination">
                  <button
                    disabled={page === 1 || pageBusy}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    이전
                  </button>
                  <span>{page} 페이지 · 최대 50개</span>
                  <button
                    disabled={!pageMore || pageBusy}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    다음
                  </button>
                </div>
              </Panel>
            )}
          </div>
        </main>
      </div>
      {preferences.events && (
        <section className="event-dock" aria-label="하단 이벤트">
          <div className="dock-tabs">
            <button
              className={bottomTab === "events" ? "active" : ""}
              onClick={() => setBottomTab("events")}
            >
              Engine 이벤트
            </button>
            <button
              className={bottomTab === "requests" ? "active" : ""}
              onClick={() => setBottomTab("requests")}
            >
              조회 기록
            </button>
            <span className="muted">
              {bottomTab === "events"
                ? "Engine 제공 이벤트"
                : "현재 브라우저 세션의 Engine 조회 기록"}
            </span>
            <button
              className="dock-close"
              aria-label="이벤트 창 숨기기"
              onClick={() => setPreferences((p) => ({ ...p, events: false }))}
            >
              <PanelBottomClose size={15} />
            </button>
          </div>
          <div className="dock-table">
            <table>
              <thead>
                <tr>
                  <th>시간</th>
                  <th>대상 / 사용자</th>
                  <th>설명</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {bottomTab === "events"
                  ? inventory.events.map((event) => (
                      <tr key={event.id}>
                        <td>{String(event.time || "—")}</td>
                        <td>{String(event.name || "Engine")}</td>
                        <td>{event.description || event.id}</td>
                        <td>
                          <Status value={String(event.severity || "info")} />
                        </td>
                      </tr>
                    ))
                  : logs.map((row) => (
                      <tr key={row.id}>
                        <td>{row.time}</td>
                        <td>{auth.username}</td>
                        <td>{row.action}</td>
                        <td>
                          <Status value={row.status} />
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
            {bottomTab === "events" && !inventory.events.length && (
              <p className="empty">
                {errors.events
                  ? "이벤트 조회 실패"
                  : "표시할 이벤트가 없습니다."}
              </p>
            )}
          </div>
        </section>
      )}
      <footer className="statusbar">
        <span>
          <span
            className={
              "tiny-dot " + (!failures.length && updated ? "online" : "")
            }
          />{" "}
          {loading
            ? "조회 중…"
            : failures.length
              ? "일부 조회 실패"
              : "조회 대기 / 완료"}{" "}
          · 마지막 갱신 {updated || "—"}
        </span>
        <span>
          {preferences.refresh
            ? `Engine ${preferences.refresh}초 자동 갱신`
            : "수동 갱신"}
          <button
            aria-label="이벤트 창 표시 전환"
            onClick={() => setPreferences((p) => ({ ...p, events: !p.events }))}
          >
            <PanelBottomOpen size={14} />
          </button>
        </span>
      </footer>
      {modal}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
