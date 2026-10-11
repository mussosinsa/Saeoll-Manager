import React, { useEffect, useState } from "react";
import {
  Network,
  Server,
  Save,
  Plus,
  Trash2,
  RefreshCw,
  ShieldCheck,
  BookOpen,
} from "lucide-react";
import { Panel } from "./ui";
import "./integrations.css";

type Engine = {
  api_url: string;
  ca_file: string;
  sso_token_url: string;
  sso_scope: string;
  token_login: boolean;
};
type Access = {
  namespaces: string[];
  cluster_resources: boolean;
  logs: boolean;
  configmaps: boolean;
  secrets: boolean;
  rbac: boolean;
};
type Cluster = {
  id: string;
  name: string;
  server: string;
  ca_file: string;
  token_file: string;
  users: Record<string, Access>;
  node_vm_map: Record<string, string>;
};
type Settings = {
  engine: Engine;
  active_engine: Engine;
  engine_revision: string;
  clusters: Cluster[];
  clusters_revision: string;
  restart_required: boolean;
  credential_root: string;
};
const initialAccess: Access = {
  namespaces: [],
  cluster_resources: false,
  logs: false,
  configmaps: false,
  secrets: false,
  rbac: false,
};
const sampleEngine: Engine = {
  api_url: "https://engine.example.com/ovirt-engine/api",
  ca_file: "/etc/oma/credentials/engine-ca.pem",
  sso_token_url: "https://engine.example.com/ovirt-engine/sso/oauth/token",
  sso_scope: "ovirt-app-api",
  token_login: true,
};
const sampleCluster = (): Cluster => ({
  id: "production",
  name: "Production Kubernetes",
  server: "https://k8s-api.example.com:6443",
  ca_file: "/etc/oma/credentials/production-ca.pem",
  token_file: "/etc/oma/credentials/production-token",
  users: {},
  node_vm_map: {},
});
async function request<T>(
  path: string,
  csrf: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch("/api/integrations" + path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(method === "GET" ? {} : { "x-csrf-token": csrf }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "설정 형식이 올바르지 않습니다. URL, 식별자, 권한 항목을 확인하세요.",
    );
  return data;
}
function Guide() {
  return (
    <div className="integration-guide">
      <h3>1. 최초 관리자 로그인 준비</h3>
      <p>
        서버의 /etc/oma/oma.env에서 Engine URL·CA·SSO와
        OMA_ENABLE_OVIRT_TOKEN_LOGIN=true를 설정합니다. OMA_DEMO=false,
        OMA_COOKIE_SECURE=true를 사용하고 서비스를 재시작한 뒤 HTTPS로
        로그인하세요.
      </p>
      <h3>2. 설정 메뉴 활성화</h3>
      <pre>{`OMA_CONFIG_ADMINS=admin@internal
OMA_CONFIG_CREDENTIAL_ROOT=/etc/oma/credentials
OMA_ENGINE_CONFIG_FILE=/var/lib/oma/config/engine.json
OMA_K8S_CONFIG_FILE=/var/lib/oma/config/clusters.json`}</pre>
      <p>
        관리자는 로그인 화면에 입력하는 정확한 사용자 이름으로 지정합니다.
        쉼표로 여러 명을 지정할 수 있습니다. 메뉴에서 관리자 권한 자체를 변경할
        수는 없습니다.
      </p>
      <h3>3. 서버 파일 및 권한</h3>
      <p>
        CA와 토큰 파일은 자격증명 디렉터리에 두고 oma 계정이 읽도록 설정합니다.
        /var/lib/oma/config는 oma 계정이 쓰도록 준비하고 systemd의
        ReadWritePaths에도 허용하세요. 토큰 원문을 화면에 붙여넣지 않습니다.
      </p>
      <h3>4. 연결 확인 → 저장 → 적용</h3>
      <p>
        Engine 연결 확인은 TLS/HTTP 도달성 검사입니다. 저장 후 관리자가 서비스를
        재시작하고 재로그인해야 새 Engine 설정이 적용됩니다. Kubernetes는 저장
        후 다음 API 요청부터 적용되며 Kubernetes 화면을 다시 열어 클러스터
        목록을 갱신하세요.
      </p>
      <h3>5. Kubernetes 권한 및 검증</h3>
      <p>
        ServiceAccount의 최소 RBAC와 사용자별 네임스페이스 접근을 모두 설정해야
        합니다. 연결 검사는 설정된 네임스페이스 하나의 Pod 목록(없으면 Node
        목록)만 검사합니다. Secret·로그·메트릭 등은 각각 검증하세요. 토큰은
        운영자가 만료 전에 교체해야 합니다.
      </p>
      <p>
        전체 명령, 인증서 준비, 장애 대응 및 복구 방법: 저장소의{" "}
        <strong>docs/integration-setup.md</strong>
      </p>
    </div>
  );
}
export default function Integrations({
  csrf,
  onDirtyChange,
}: {
  csrf: string;
  onDirtyChange: (value: boolean) => void;
}) {
  const [access, setAccess] = useState<{
      can_edit: boolean;
      demo: boolean;
    } | null>(null),
    [settings, setSettings] = useState<Settings | null>(null);
  const [engine, setEngine] = useState<Engine>(sampleEngine),
    [clusters, setClusters] = useState<Cluster[]>([]),
    [index, setIndex] = useState(0);
  const [tab, setTab] = useState<"engine" | "kubernetes" | "guide">("engine"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [check, setCheck] = useState(""),
    [engineDirty, setEngineDirty] = useState(false),
    [clustersDirty, setClustersDirty] = useState(false),
    [newUser, setNewUser] = useState(""),
    [newNode, setNewNode] = useState(""),
    [newVm, setNewVm] = useState("");
  const dirty = engineDirty || clustersDirty;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const cluster = clusters[index];
  const canSave = !!access?.can_edit && !!settings && !busy;
  const load = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    setCheck("");
    try {
      const a = await request<{ can_edit: boolean; demo: boolean }>(
        "/status",
        csrf,
      );
      setAccess(a);
      if (a.can_edit) {
        const s = await request<Settings>("/settings", csrf);
        setSettings(s);
        setEngine(s.engine);
        setClusters(s.clusters);
        setIndex(0);
        setEngineDirty(false);
        setClustersDirty(false);
      } else if (a.demo) {
        setClusters([
          {
            ...sampleCluster(),
            id: "demo-example",
            name: "설정 예시 (실제 연결 아님)",
          },
        ]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const changeEngine = (key: keyof Engine, value: string | boolean) => {
    setEngine((old) => ({ ...old, [key]: value }));
    setEngineDirty(true);
    setCheck("");
    setMessage("");
  };
  const changeCluster = (next: Cluster) => {
    setClusters((old) => old.map((c, i) => (i === index ? next : c)));
    setClustersDirty(true);
    setCheck("");
    setMessage("");
  };
  const doCheck = async () => {
    setBusy(true);
    setError("");
    setCheck("");
    try {
      if (tab === "engine") {
        const r = await request<{ http_status: number }>(
          "/engine/check",
          csrf,
          "POST",
          engine,
        );
        setCheck(
          `TLS/HTTP 연결 성공 (HTTP ${r.http_status}). 계정 인증·SSO 검증은 아직 수행하지 않았습니다.`,
        );
      } else if (cluster) {
        const r = await request<{ checked_path: string }>(
          "/kubernetes/check",
          csrf,
          "POST",
          cluster,
        );
        setCheck(
          "목록 조회 성공: " +
            r.checked_path +
            " · 나머지 리소스 RBAC는 별도 확인이 필요합니다.",
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (tab === "engine") {
        const r = await request<{
          revision: string;
          restart_required: boolean;
        }>("/engine", csrf, "PUT", {
          engine,
          revision: settings.engine_revision,
        });
        setSettings((s) =>
          s
            ? {
                ...s,
                engine,
                engine_revision: r.revision,
                restart_required: r.restart_required,
              }
            : s,
        );
        setMessage(
          r.restart_required
            ? "Engine 설정 저장 완료. systemctl restart oma 실행 후 재로그인하세요."
            : "Engine 설정 저장 완료. 현재 적용된 설정과 같습니다.",
        );
      } else {
        const r = await request<{ revision: string }>(
          "/kubernetes",
          csrf,
          "PUT",
          {
            clusters: clusters.map((c) => ({
              ...c,
              users: Object.fromEntries(
                Object.entries(c.users).map(([u, a]) => [
                  u,
                  { ...a, namespaces: a.namespaces.filter(Boolean) },
                ]),
              ),
            })),
            revision: settings.clusters_revision,
          },
        );
        setSettings((s) =>
          s ? { ...s, clusters, clusters_revision: r.revision } : s,
        );
        setMessage(
          "Kubernetes 설정 저장 완료. 다음 요청부터 적용됩니다. Kubernetes 화면을 다시 열어주세요.",
        );
      }
      if (tab === "engine") setEngineDirty(false);
      else setClustersDirty(false);
    } catch (e) {
      setError(
        String(e) +
          " 저장 상태가 불확실하면 서버 설정을 다시 불러와 확인하세요.",
      );
    } finally {
      setBusy(false);
    }
  };
  const flags: [keyof Omit<Access, "namespaces">, string][] = [
    ["cluster_resources", "노드·클러스터 리소스"],
    ["logs", "Pod 로그"],
    ["configmaps", "ConfigMap 값"],
    ["secrets", "Secret 메타데이터"],
    ["rbac", "RBAC 조회"],
  ];
  return (
    <div className="integrations">
      <div className="integration-tabs">
        <button
          className={tab === "engine" ? "active" : ""}
          onClick={() => {
            setTab("engine");
            setCheck("");
          }}
        >
          <Server size={15} />
          oVirt 4.5.6 Engine
        </button>
        <button
          className={tab === "kubernetes" ? "active" : ""}
          onClick={() => {
            setTab("kubernetes");
            setCheck("");
          }}
        >
          <Network size={15} />
          Kubernetes 클러스터
        </button>
        <button
          className={tab === "guide" ? "active" : ""}
          onClick={() => setTab("guide")}
        >
          <BookOpen size={15} />
          설정 가이드
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <p className="integration-success" role="status">
          {message}
        </p>
      )}
      {check && (
        <p className="integration-success" role="status">
          {check}
        </p>
      )}
      {access && !access.can_edit && (
        <p className="info-note">
          <ShieldCheck size={16} />
          {access.demo
            ? "데모에서는 예시 입력만 가능하며 실제 저장·연결 검사는 차단됩니다."
            : "관리자만 연결 설정을 조회·변경할 수 있습니다. OMA_CONFIG_ADMINS 등록을 서버 관리자에게 요청하세요."}
        </p>
      )}
      {busy && <p role="status">처리 중…</p>}
      {tab === "guide" ? (
        <Panel title="연동 설정 방법">
          <Guide />
        </Panel>
      ) : (
        <>
          {(access?.can_edit || access?.demo) && (
            <>
              <div className="integration-toolbar">
                <button
                  disabled={!canSave || (tab === "kubernetes" && !cluster)}
                  onClick={doCheck}
                >
                  연결 확인
                </button>
                <button className="primary" disabled={!canSave} onClick={save}>
                  <Save size={14} />
                  {tab === "engine" ? "Engine 설정 저장" : "전체 클러스터 저장"}
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      !dirty ||
                      window.confirm(
                        "저장하지 않은 변경을 버리고 서버 설정을 불러올까요?",
                      )
                    )
                      void load();
                  }}
                >
                  <RefreshCw size={14} />
                  서버 설정 다시 불러오기
                </button>
                <span className="muted">
                  {dirty ? "저장되지 않은 변경 있음" : "서버 설정 / 예시"}
                </span>
              </div>
              {tab === "engine" ? (
                <Panel title="oVirt Engine REST API / SSO">
                  <fieldset disabled={busy} className="integration-fields">
                    <label>
                      Engine REST API URL
                      <input
                        value={engine.api_url}
                        onChange={(e) =>
                          changeEngine("api_url", e.target.value)
                        }
                        placeholder="https://engine.example.com/ovirt-engine/api"
                      />
                    </label>
                    <label>
                      CA 인증서 파일
                      <input
                        value={engine.ca_file}
                        onChange={(e) =>
                          changeEngine("ca_file", e.target.value)
                        }
                      />
                    </label>
                    <label>
                      SSO 토큰 URL
                      <input
                        value={engine.sso_token_url}
                        onChange={(e) =>
                          changeEngine("sso_token_url", e.target.value)
                        }
                      />
                    </label>
                    <label>
                      SSO scope
                      <input
                        value={engine.sso_scope}
                        onChange={(e) =>
                          changeEngine("sso_scope", e.target.value)
                        }
                      />
                    </label>
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={engine.token_login}
                        onChange={(e) =>
                          changeEngine("token_login", e.target.checked)
                        }
                      />
                      Engine 토큰 로그인 활성화
                    </label>
                  </fieldset>
                  <p className="info-note">
                    API와 SSO는 동일 HTTPS 호스트·포트를 사용합니다. 비밀번호는
                    이 설정에 저장하지 않으며 사용자 로그인 시 Engine 인증에
                    사용합니다.
                  </p>
                  {!engine.token_login && (
                    <p className="error">
                      비활성화한 설정을 적용하면 Engine 로그인이 차단됩니다.
                      복구하려면 서버 설정 파일을 수정해야 합니다.
                    </p>
                  )}
                  {settings?.restart_required && (
                    <p className="error">
                      저장된 설정과 현재 실행 설정이 다릅니다. 서비스 재시작이
                      필요합니다.
                    </p>
                  )}
                  {settings && (
                    <details>
                      <summary>현재 실행 중인 Engine 주소</summary>
                      <p>{settings.active_engine.api_url}</p>
                    </details>
                  )}
                </Panel>
              ) : (
                <>
                  <div className="integration-toolbar">
                    <label>
                      등록 클러스터
                      <select
                        aria-label="설정 클러스터 선택"
                        value={cluster ? index : ""}
                        onChange={(e) => {
                          setIndex(Number(e.target.value));
                          setCheck("");
                        }}
                      >
                        {!clusters.length && (
                          <option value="">등록 없음</option>
                        )}
                        {clusters.map((c, i) => (
                          <option key={i} value={i}>
                            {c.name || c.id || "새 클러스터"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={busy || clusters.length >= 50}
                      onClick={() => {
                        setClusters((old) => [
                          ...old,
                          {
                            ...sampleCluster(),
                            id: "cluster-" + (clusters.length + 1),
                            name: "새 클러스터",
                          },
                        ]);
                        setIndex(clusters.length);
                        setClustersDirty(true);
                        setCheck("");
                      }}
                    >
                      <Plus size={14} />
                      클러스터 추가
                    </button>
                    <button
                      disabled={!cluster || busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "이 클러스터를 목록에서 제거할까요? 저장하면 접근이 중단됩니다.",
                          )
                        ) {
                          setClusters((old) =>
                            old.filter((_, i) => i !== index),
                          );
                          setIndex(0);
                          setClustersDirty(true);
                          setCheck("");
                        }
                      }}
                    >
                      <Trash2 size={14} />
                      선택 삭제
                    </button>
                  </div>
                  {cluster ? (
                    <Panel title="클러스터 연결 및 사용자 권한">
                      <fieldset className="integration-fields" disabled={busy}>
                        {(
                          [
                            ["id", "클러스터 ID"],
                            ["name", "표시 이름"],
                            ["server", "Kubernetes API URL"],
                            ["ca_file", "클러스터 CA 파일"],
                            ["token_file", "ServiceAccount 토큰 파일"],
                          ] as const
                        ).map(([key, label]) => (
                          <label key={key}>
                            {label}
                            <input
                              value={cluster[key]}
                              onChange={(e) =>
                                changeCluster({
                                  ...cluster,
                                  [key]: e.target.value,
                                })
                              }
                            />
                          </label>
                        ))}
                      </fieldset>
                      <p className="info-note">
                        CA·토큰 원문은 서버에 설치하세요. 저장·검사 시 허용된
                        디렉터리 내부 파일만 사용합니다:{" "}
                        {settings?.credential_root || "/etc/oma/credentials"}
                      </p>
                      <h3>사용자별 접근</h3>
                      <p>
                        Engine 로그인 사용자 이름과 정확히 일치해야 합니다.
                        Kubernetes RBAC도 별도로 부여해야 합니다.
                      </p>
                      <div className="integration-toolbar">
                        <input
                          aria-label="추가할 사용자 이름"
                          value={newUser}
                          onChange={(e) => setNewUser(e.target.value)}
                          placeholder="operator@internal"
                        />
                        <button
                          disabled={
                            busy ||
                            !newUser.trim() ||
                            newUser.trim() === "*" ||
                            Object.hasOwn(cluster.users, newUser.trim())
                          }
                          onClick={() => {
                            changeCluster({
                              ...cluster,
                              users: {
                                ...cluster.users,
                                [newUser.trim()]: { ...initialAccess },
                              },
                            });
                            setNewUser("");
                          }}
                        >
                          사용자 추가
                        </button>
                      </div>
                      {Object.entries(cluster.users).map(([user, a]) => (
                        <fieldset
                          key={user}
                          className="access-editor"
                          disabled={busy}
                        >
                          <legend>{user}</legend>
                          <label>
                            허용 네임스페이스 (쉼표 구분)
                            <input
                              value={a.namespaces.join(", ")}
                              onChange={(e) =>
                                changeCluster({
                                  ...cluster,
                                  users: {
                                    ...cluster.users,
                                    [user]: {
                                      ...a,
                                      namespaces:
                                        e.target.value === ""
                                          ? []
                                          : e.target.value
                                              .split(",")
                                              .map((v) => v.trim()),
                                    },
                                  },
                                })
                              }
                            />
                          </label>
                          <div className="access-flags">
                            {flags.map(([key, label]) => (
                              <label key={key}>
                                <input
                                  type="checkbox"
                                  checked={a[key]}
                                  onChange={(e) =>
                                    changeCluster({
                                      ...cluster,
                                      users: {
                                        ...cluster.users,
                                        [user]: {
                                          ...a,
                                          [key]: e.target.checked,
                                        },
                                      },
                                    })
                                  }
                                />
                                {label}
                              </label>
                            ))}
                          </div>
                          <button
                            onClick={() => {
                              const next = { ...cluster.users };
                              delete next[user];
                              changeCluster({ ...cluster, users: next });
                            }}
                          >
                            사용자 제거
                          </button>
                        </fieldset>
                      ))}
                      <h3>Node → oVirt VM UUID 매핑</h3>
                      <div className="integration-toolbar">
                        <input
                          aria-label="매핑할 노드 이름"
                          placeholder="worker-1"
                          value={newNode}
                          onChange={(e) => setNewNode(e.target.value)}
                        />
                        <input
                          aria-label="매핑할 VM UUID"
                          placeholder="Engine VM UUID"
                          value={newVm}
                          onChange={(e) => setNewVm(e.target.value)}
                        />
                        <button
                          disabled={busy || !newNode.trim() || !newVm.trim()}
                          onClick={() => {
                            changeCluster({
                              ...cluster,
                              node_vm_map: {
                                ...cluster.node_vm_map,
                                [newNode.trim()]: newVm.trim(),
                              },
                            });
                            setNewNode("");
                            setNewVm("");
                          }}
                        >
                          매핑 추가
                        </button>
                      </div>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Node</th>
                              <th>VM UUID</th>
                              <th>작업</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(cluster.node_vm_map).map(
                              ([node, vm]) => (
                                <tr key={node}>
                                  <td>{node}</td>
                                  <td>{vm}</td>
                                  <td>
                                    <button
                                      disabled={busy}
                                      onClick={() => {
                                        const next = { ...cluster.node_vm_map };
                                        delete next[node];
                                        changeCluster({
                                          ...cluster,
                                          node_vm_map: next,
                                        });
                                      }}
                                    >
                                      매핑 제거
                                    </button>
                                  </td>
                                </tr>
                              ),
                            )}
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  ) : (
                    <p className="empty">
                      클러스터 추가로 연결 정보를 등록하세요. 빈 목록을 저장하면
                      기존 클러스터 접근이 제거됩니다.
                    </p>
                  )}
                </>
              )}
            </>
          )}
          {!access?.can_edit && !access?.demo && (
            <Panel title="초기 설정 가이드">
              <Guide />
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
