# OV-Works Kubernetes 현황 조회

## 구현 범위

React 화면 상단의 **Kubernetes** 버튼에서 클러스터, 네임스페이스, 관리 대상을 선택합니다.
클러스터별로 한 번씩 조회하므로 다른 클러스터 장애가 나머지 클러스터의 조회를 막지 않습니다.
노드, Pod/컨테이너, Deployment, StatefulSet, DaemonSet, Job, CronJob, 이벤트,
ConfigMap, Secret 메타데이터, Role/Binding, ClusterRole/Binding, Node/Pod 메트릭을 지원합니다.
이름을 클릭하면 상세 정보가 표시됩니다. Pod 상세에서는 컨테이너별 현재/이전 로그를 조회합니다.
조회는 화면 진입, 대상 변경, 새로 고침 시 수행하며 일반 목록에는 다음 페이지 버튼이 있습니다.
메트릭 수치는 Kubernetes 원래 단위(n, m, Ki 등)로 표시합니다. Metrics API가 없으면 미제공으로 표시합니다.
메트릭 403, 인증 오류, 연결 오류를 사용량 0이나 미제공으로 숨기지 않습니다.

현재 버전은 조회 전용입니다. ConfigMap/Secret/RBAC 편집, scale/restart, exec, drain,
VM 전원 변경, watch, 시계열 저장, 알림, 사용자 OIDC 연동은 구현하지 않았습니다.
실제 클러스터 통합 검증은 별도로 필요합니다. 테스트에서 사용한 모의 API는 실제 연동 증거가 아닙니다.

## 구성

브라우저 → FastAPI → 클러스터별 Kubernetes HTTPS API 서버.
oVirt Engine 인증과 Kubernetes 인증은 독립적이며 Engine 토큰을 재사용하지 않습니다.
libvirt/KVM/VDSM 직접 연결은 필요하지 않습니다.

1. `deploy/kubernetes-clusters.example.json`을 `/etc/oma/kubernetes/clusters.json`으로 복사합니다.
2. 클러스터 ID, API 서버 HTTPS 주소, CA PEM 파일, ServiceAccount 토큰 파일을 지정합니다.
   API 주소에는 경로, 사용자 정보, query를 넣지 않습니다. 프록시 환경변수는 사용하지 않으므로
   OV-Works 서버에서 API 서버로 직접 DNS/TCP 연결이 가능해야 합니다. TLS 검증은 필수입니다.
3. `users` 키는 **현재 OV-Works 로그인 세션의 정확한 username**입니다.
   사용자별 허용 네임스페이스를 명시합니다. `*` 와일드카드는 지원하지 않습니다.
   사용자에게 보이는 클러스터와 모든 데이터 API에서 이 권한을 다시 확인합니다.
4. `OMA_K8S_CONFIG_FILE=/etc/oma/kubernetes/clusters.json`을 `/etc/oma/oma.env`에 추가합니다.
5. `systemctl restart oma` 후 웹에서 Engine 계정으로 로그인하고 Kubernetes 화면을 엽니다.

파일 권한 예시(서버에서 실제 서비스 계정에 맞게 적용):

```bash
install -d -o root -g oma -m 0750 /etc/oma/kubernetes
chown root:oma /etc/oma/kubernetes/clusters.json /etc/oma/kubernetes/production-token
chmod 0640 /etc/oma/kubernetes/clusters.json /etc/oma/kubernetes/production-token
chmod 0644 /etc/oma/kubernetes/production-ca.pem
```

토큰/설정 파일은 소스 저장소나 frontend/dist에 두지 않습니다. CA는 신뢰된 경로로 전달받습니다.
클러스터 설정과 토큰 파일은 매 요청마다 다시 읽습니다. 토큰 교체 시 원자적으로 파일을 교체하고
서비스 계정이 계속 읽을 수 있도록 권한을 유지하세요. Kubernetes TokenRequest 토큰의 만료에 맞춘
자동 갱신은 배포 운영자가 구성해야 하며 이 앱은 토큰을 생성하거나 갱신하지 않습니다.
설정 오류는 503으로 닫힌 상태로 처리합니다. 설정 파일이 없으면 클러스터 목록이 비어 있습니다.

## 권한

`deploy/kubernetes-readonly-rbac.yaml`은 ServiceAccount, 노드 조회 권한, 특정 네임스페이스의
워크로드/로그/이벤트/메트릭 조회 권한 예시입니다. 실제 네임스페이스로 수정해서 클러스터 관리자가 적용합니다.
이 예시는 Secret, ConfigMap, RBAC 조회 권한을 부여하지 않습니다.

OV-Works 권한 플래그:

| 플래그 | 범위 |
| --- | --- |
| namespaces | 정확한 네임스페이스 목록; 전 네임스페이스 조회 API 없음 |
| cluster_resources | 노드, 노드 메트릭, 클러스터 RBAC 조회 허용 |
| logs | Pod 로그 조회 |
| configmaps | ConfigMap 값 조회; 민감 정보를 포함할 수 있음 |
| secrets | Secret 이름/타입/키 이름만 반환 |
| rbac | Role/Binding 조회; ClusterRole/Binding은 cluster_resources도 필요 |

선택 기능은 Kubernetes RBAC에서도 해당 리소스의 get/list 권한을 별도로 부여해야 합니다.
Secret 목록은 Kubernetes 서버에서 값까지 반환하므로 백엔드 ServiceAccount에는 실제 Secret 읽기 권한이
생깁니다. 이를 허용할 수 없다면 secrets 플래그를 false로 유지하고 Kubernetes에서도 권한을 부여하지 마세요.
백엔드는 Secret data 값, annotation, managedFields를 브라우저에 반환하지 않습니다.
Pod 환경변수/원본 spec도 반환하지 않습니다. 로그/이벤트/상태 메시지/ConfigMap에는 앱 자체의 민감 정보가
포함될 수 있으므로 적절한 사용자에게만 조회를 허용해야 합니다.
로그 조회 시도와 ConfigMap/Secret 조회는 기존 감사 체인에 기록하며 토큰/로그 본문/Secret 값은 기록하지 않습니다.
모든 엔드포인트는 세션을 요구하고 mutation API는 없습니다.
ServiceAccount 공유 방식이므로 Kubernetes 감사에는 서비스 계정이 보이며 최종 사용자 신원은
OV-Works 감사 기록을 함께 확인해야 합니다. 브라우저나 요청 파라미터에서 API 주소/토큰을 받지 않습니다.

## VM ↔ 노드

`node_vm_map`은 정확한 Node 이름 → oVirt VM UUID 매핑입니다. IP나 이름 유사성으로 자동 확정하지 않습니다.
노드 화면의 VM 링크를 클릭하면 현재 로그인 사용자가 조회한 VM 상세로 이동합니다.
노드 상세의 **이 노드의 Pod 조회**로 선택한 네임스페이스의 Pod를 서버 측 필터링하여 조회하고, VM 상세에서 현재 물리 호스트를 확인합니다.
VM이 현재 인벤토리에 없다면 링크 없이 UUID를 표시합니다. 매핑은 관리자가 설정 파일에서 유지합니다.
providerID는 참고 정보로 표시하며 자동 매핑 근거로 사용하지 않습니다.

## 데모와 검증

기존 `OMA_DEMO=true` + demo/demo 로그인으로 샘플 클러스터를 이용합니다.
데모 세션은 실제 클러스터 설정에 접근하지 않습니다. control-plane, worker-1, worker-2와
문서 검색/파싱/임베딩/포털 Pod 샘플을 표시합니다. 데모 VM 연결은 기존 샘플 v1/v2/v3를 이용하며
실제 VM 101/102/103을 발견한 결과가 아닙니다. 데모 메트릭은 미제공입니다.

```bash
# 저장소 루트, 설치된 Python 가상환경에서
python -m pytest -q tests
cd frontend
npm run build
```

실제 운영 검증: 허용/비허용 계정과 네임스페이스 접근, 토큰 만료/회전, CA 검증 실패,
API 서버 장애 격리, Pod 다중 컨테이너 로그/이전 로그, Secret 응답 비노출, 메트릭 유무,
목록 다음 페이지, 재배치 후 Pod node 정보와 VM 매핑을 확인하세요.

## 후속 운영 기능

ConfigMap/Secret/RBAC 변경을 도입하려면 사용자 신원 연계, 별도 변경 권한, CSRF 검증,
변경 미리보기, resourceVersion 충돌 처리, 감사 및 회복 절차를 먼저 설계해야 합니다.
Kubernetes Worker VM 종료는 cordon/drain, PDB, 로컬 데이터, Control Plane quorum을 고려해야 합니다.
