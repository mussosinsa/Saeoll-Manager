# Engine 4.5.6 / Kubernetes 연동 설정 가이드

## 1. 메뉴와 권한

상단 **연동 설정** 메뉴에 다음 탭이 있습니다.

| 탭 | 입력/기능 | 적용 시점 |
| --- | --- | --- |
| oVirt 4.5.6 Engine | REST API URL, CA 파일, SSO URL/scope, 토큰 로그인 활성화, 연결 확인, 저장 | 저장 후 서비스 재시작 |
| Kubernetes 클러스터 | 클러스터 추가/삭제, API URL, CA/토큰 파일, 사용자별 네임스페이스·조회 권한, Node→VM UUID | 저장 후 다음 API 요청 |
| 설정 가이드 | 초기 설정과 적용 절차 | 모든 로그인 사용자 열람 가능 |

서버의 `OMA_CONFIG_ADMINS`에 등록된 **정확한 로그인 사용자 이름**만 운영 설정을 조회·변경할 수 있습니다.
미등록 사용자는 안내만 볼 수 있습니다. 데모에서는 예시 입력이 가능하지만 저장·연결 검사는 서버에서도 차단됩니다.
관리자는 API 목적지와 사용자 접근을 변경할 수 있는 높은 권한이므로 일반 조회 사용자에게 부여하지 마세요.

이 메뉴는 처음 로그인하기 전의 bootstrap 도구가 아닙니다. 최초 Engine 인증은 서버 환경변수로
한 번 준비해야 합니다. 관리자 계정·비밀번호를 생성하거나 인증을 우회하는 별도 초기 계정은 없습니다.
비밀번호, 토큰, 인증서 원문을 웹 화면에 붙여넣지 않습니다. 설정에는 서버 파일 경로만 저장합니다.

## 2. 서버 준비

이 가이드는 저장소 `/opt/oma`, 서비스 계정 `oma`, systemd 서비스 `oma`를 기준으로 합니다.
경로가 다르면 일관되게 변경하세요. 사용자 브라우저→OV-Works는 HTTPS, 백엔드→Engine/Kubernetes도
TLS 인증서를 검증하는 HTTPS로 구성합니다. 백엔드는 127.0.0.1:8088에 바인딩합니다.

```bash
# root로 실행. 기존 사용자/환경은 유지합니다.
id oma >/dev/null 2>&1 || useradd --system --no-create-home oma
install -d -o root -g oma -m 0750 /etc/oma /etc/oma/credentials
install -d -o oma -g oma -m 0750 /var/log/oma
install -d -o oma -g oma -m 0700 /var/lib/oma/config

cd /opt/oma
python3.11 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cd frontend
npm install --include=dev
npm run build
```

`deploy/oma-apache.conf.example`을 실제 도메인/TLS 인증서에 맞게 적용하여 `frontend/dist`를 제공하고
`/api/`를 백엔드로 프록시합니다. 코드·가상환경은 oma 계정이 읽고 실행할 수 있어야 합니다.
운영에서는 Vite 개발 서버를 외부에 노출하지 않습니다.

## 3. Engine CA와 최초 로그인

Engine 관리자에게 HTTPS 인증서의 신뢰 체인을 받아 검증된 경로로 전달받으세요.
기본 Engine CA는 일반적으로 Engine 서버의 `/etc/pki/ovirt-engine/ca.pem`에 있습니다.
외부 CA로 웹 인증서를 교체한 경우 실제 웹 인증서의 발급 CA 체인을 사용해야 합니다.
SSH로 가져올 경우 호스트 키를 확인하고, TLS 검증을 끄는 방식으로 다운로드하지 마세요.

```bash
# /secure/engine-ca.pem은 신뢰된 경로로 전달받은 파일
install -o root -g oma -m 0640 /secure/engine-ca.pem /etc/oma/credentials/engine-ca.pem
```

`/etc/oma/oma.env`에 다음을 설정합니다. 예시 도메인은 실제 Engine FQDN으로 바꾸고
`admin@internal`은 실제 사용할 관리자 로그인 이름으로 바꾸세요. 기존 설정에 중복 키를 추가하지 마세요.

```ini
OVIRT_API_URL=https://engine.example.com/ovirt-engine/api
OVIRT_CA_FILE=/etc/oma/credentials/engine-ca.pem
OVIRT_SSO_TOKEN_URL=https://engine.example.com/ovirt-engine/sso/oauth/token
OVIRT_SSO_SCOPE=ovirt-app-api
OMA_ENABLE_OVIRT_TOKEN_LOGIN=true
OMA_ALLOW_PASSWORD_LOGIN=false
OMA_DEMO=false
OMA_COOKIE_SECURE=true
OMA_ENABLE_WRITES=false
OMA_AUDIT_PATH=/var/log/oma/audit.jsonl

OMA_CONFIG_ADMINS=admin@internal
OMA_CONFIG_CREDENTIAL_ROOT=/etc/oma/credentials
OMA_ENGINE_CONFIG_FILE=/var/lib/oma/config/engine.json
OMA_K8S_CONFIG_FILE=/var/lib/oma/config/clusters.json
```

여러 설정 관리자는 `OMA_CONFIG_ADMINS=admin@internal,operator@example`처럼 쉼표로 구분합니다.
최초 설치 시 engine.json은 만들 필요가 없습니다. 파일이 없으면 `OVIRT_*` 환경변수가 사용됩니다.
Kubernetes 파일이 없으면 클러스터 목록은 비어 있습니다. 기존 파일은 삭제하거나 덮어쓰지 마세요.

```bash
chmod 0600 /etc/oma/oma.env
# 새 설치에서 예제 서비스 사용. 기존 custom unit은 차이를 검토하여 병합하세요.
cp /opt/oma/deploy/oma.service /etc/systemd/system/oma.service
systemctl daemon-reload
systemctl enable --now oma
# 이미 실행 중인 서비스의 환경변수를 변경했다면
systemctl restart oma
systemctl status oma
journalctl -u oma -n 100 --no-pager
```

서비스 핵심 설정은 다음과 같습니다.

```ini
WorkingDirectory=/opt/oma
EnvironmentFile=/etc/oma/oma.env
ExecStart=/opt/oma/backend/.venv/bin/uvicorn backend.app:app --host 127.0.0.1 --port 8088 --workers 1
ReadWritePaths=/var/log/oma -/var/lib/oma/config
```

`-` 접두사는 메뉴를 사용하지 않는 기존 설치에서 디렉터리가 없더라도 서비스가 시작되도록 합니다.
**설정 저장을 사용하려면 해당 디렉터리는 반드시 미리 생성해야 합니다.**
`OMA_*_CONFIG_FILE` 경로를 바꾸면 systemd 쓰기 허용 경로도 변경해야 합니다.
자격증명 디렉터리는 root 소유로 두고 웹 서비스가 파일을 수정하지 못하게 유지하세요.
파일 선택 기능은 이 디렉터리 밖 파일과 밖으로 나가는 심볼릭 링크를 거부합니다.

웹에서 Engine 계정으로 로그인합니다. `curl /api/health/ready`의 configured는 설정 상태만 뜻하며
실제 인증 검증이 아닙니다. 대시보드의 Engine 연결 확인과 인벤토리 조회까지 확인하세요.

## 4. 메뉴에서 Engine 변경

1. **연동 설정 → oVirt 4.5.6 Engine**에서 현재 입력값을 확인합니다.
2. API URL, CA 경로, SSO URL과 scope를 입력합니다. API·SSO는 동일 HTTPS 호스트/포트여야 합니다.
3. **연결 확인**을 누릅니다. CA 검증과 API의 HTTP 응답(200/401/403)만 검사합니다.
   현재 세션 토큰·쿠키·비밀번호를 새 주소에 전송하지 않으며 SSO 성공을 보증하지 않습니다.
4. **Engine 설정 저장**을 누릅니다. 저장한 JSON은 환경변수보다 우선하며 원자적으로 교체됩니다.
5. 서버에서 `systemctl restart oma` 후 브라우저를 새로고침하고 재로그인합니다.
6. 로그인 성공, 인벤토리 조회, 대시보드의 Engine 연결 확인을 검증합니다.

저장만으로 실행 중인 연결은 바뀌지 않습니다. 화면에 재시작 필요 여부와 현재 실행 주소를 표시합니다.
재시작하면 메모리 세션이 사라집니다. 토큰 로그인을 비활성화하면 재시작 후 로그인이 차단되므로
서버 파일로 복구해야 합니다. VM 쓰기 기능은 설정 메뉴와 별개이며 여전히 차단됩니다.

## 5. Kubernetes ServiceAccount와 파일 준비

클러스터 관리자가 `deploy/kubernetes-readonly-rbac.yaml`의 `administration` 네임스페이스를
실제 업무 네임스페이스로 수정해 적용합니다. 예시에는 노드, Pod/로그, 워크로드, 이벤트, 메트릭
조회만 있고 Secret/ConfigMap/RBAC 조회 권한은 없습니다. 필요한 경우에만 별도 권한을 추가하세요.

```bash
# 올바른 대상 클러스터 컨텍스트인지 먼저 확인한 관리용 단말에서
kubectl config current-context
kubectl apply -f deploy/kubernetes-readonly-rbac.yaml
# TokenRequest 기반 단기 토큰. 실제 수명은 클러스터 정책을 따릅니다.
umask 077
kubectl -n ov-works create token ov-works-reader --duration=1h > /secure/production-token
```

선택한 클러스터의 CA 인증서도 신뢰된 관리 경로로 전달받습니다. 관리용 kubeconfig 전체를
서비스 서버에 복사하지 마세요. `/secure/production-token`과 CA를 안전하게 전달한 후 앱 서버에서:

```bash
install -o root -g oma -m 0640 /secure/production-ca.pem /etc/oma/credentials/production-ca.pem
install -o root -g oma -m 0640 /secure/production-token /etc/oma/credentials/production-token
```

토큰 만료 전에 새 토큰으로 파일을 원자적으로 교체하는 운영 절차를 구성해야 합니다.
이 앱은 토큰을 자동 발급/갱신하지 않습니다. 백엔드는 요청마다 토큰 파일을 다시 읽습니다.

## 6. 메뉴에서 Kubernetes 등록

1. **연동 설정 → Kubernetes 클러스터 → 클러스터 추가**.
2. 고유 ID, 표시 이름, `https://k8s-api.example.com:6443` 형태의 주소를 입력합니다.
   주소에 API 경로나 query를 넣지 않습니다.
3. CA·ServiceAccount 토큰 파일 경로를 입력합니다. 경로는 `OMA_CONFIG_CREDENTIAL_ROOT` 안에 있어야 합니다.
4. **사용자 추가**에서 정확한 Engine 로그인 이름을 추가합니다.
5. 쉼표로 허용 네임스페이스를 입력하고 필요한 조회 플래그만 선택합니다.
   노드만 조회할 사용자는 네임스페이스를 비워두고 노드·클러스터 리소스 플래그를 켤 수 있습니다.
6. 필요하면 Node 이름→Engine VM UUID 매핑을 추가합니다. VM 표시 이름/번호 대신 실제 UUID를 사용합니다.
7. **연결 확인**으로 ServiceAccount의 목록 조회를 확인합니다. 등록된 네임스페이스 중 하나의
   Pod 목록을 최대 1개 요청하고, 네임스페이스가 없으면 Node 목록을 확인합니다.
   이 확인은 모든 사용자 권한과 전체 리소스를 검증하지 않습니다.
8. **전체 클러스터 저장**. Kubernetes 화면을 다시 열고 해당 사용자로 조회를 확인합니다.

저장은 전체 목록을 교체합니다. 클러스터를 삭제한 뒤 저장하면 해당 접근이 제거됩니다.
클러스터가 0개인 목록 저장은 전체 제거를 의미합니다. 저장 전 변경을 확인하세요.
설정 사용자 권한과 Kubernetes ServiceAccount RBAC는 둘 다 충족되어야 합니다.
Secret 조회 플래그는 브라우저에 값이 아닌 메타데이터만 제공하지만 ServiceAccount에는 실제
Secret 읽기 권한이 필요하므로 이를 허용하지 않으려면 두 계층 모두에서 비활성화하세요.

## 7. 기존 수동 설정에서 이전

기존 `/etc/oma/kubernetes/clusters.json`을 사용 중이라면 서비스 정지/유지보수 중 기존 파일을
보관하고 `/var/lib/oma/config/clusters.json`으로 복사하여 oma 소유/0600으로 설정합니다.
CA/토큰을 허용 자격증명 디렉터리로 옮겨 JSON 경로를 수정하고 환경변수도 새 경로로 변경하세요.
중복된 클러스터 ID, 와일드카드 사용자/네임스페이스, 알 수 없는 필드는 메뉴에서 거부됩니다.
관리자를 포함해 각 사용자의 허용 범위를 재확인하세요. 클러스터 설정 관리 권한이
자동으로 Kubernetes 데이터 조회 권한을 부여하지는 않습니다.

## 8. 장애 대응 / 복구

| 현상 | 확인 사항 |
| --- | --- |
| 메뉴에서 저장 불가 | 데모인지, OMA_CONFIG_ADMINS가 정확한 로그인 이름인지, 재시작했는지 |
| 설정 로드 503 | 두 설정 파일 환경변수, 올바른 JSON/스키마, 파일 읽기 권한 |
| 파일 검증 422 | 허용 디렉터리 안 절대 경로인지, CA PEM·토큰 내용/읽기 권한 |
| 저장 503 | 저장 디렉터리 존재/소유권, systemd ReadWritePaths, 감사 로그 권한 |
| 저장 충돌 409 | 다른 편집자가 저장함. 서버 설정 다시 불러오기 후 변경 병합 |
| Engine 검사 성공 후 로그인 실패 | 검사에는 SSO 검증이 없음. SSO URL/scope, 계정, 인증 프로필, Engine 로그 확인 |
| Kubernetes 401/502 | 토큰 만료, CA, DNS, API 주소, 네트워크 경로 |
| Kubernetes 403 | ServiceAccount RBAC 또는 앱 사용자별 네임스페이스·플래그 |
| 메트릭 미제공 | Metrics Server/API 제공 여부. 권한 오류와 구분 |

설정 API의 연결 검사는 환경의 HTTP 프록시 변수를 사용하지 않습니다. API 서버로 직접
DNS/TCP 접근이 가능해야 합니다. 인증서 검증을 비활성화해서 문제를 우회하지 마세요.
저장 중 감사 기록/디스크 오류가 생기면 파일이 이미 저장되었을 수도 있으므로 먼저 서버 설정을
다시 읽고 상태를 확인합니다. 파일 변경은 임시 파일+fsync+원자적 교체, 편집 충돌은 revision으로 감지합니다.
실패/성공한 변경 시도는 기존 감사 로그에 작업명/사용자 중심으로 기록하고 토큰·비밀번호는 기록하지 않습니다.

잘못된 Engine 설정으로 시작/로그인이 불가능하면 관리자가 서비스를 중지하고 engine.json을
별도 파일로 백업한 뒤 수정하거나 다른 이름으로 이동합니다. 기존 `OVIRT_*` 환경변수가 유효한지
확인하고 서비스를 시작하면 파일이 없는 경우 환경변수로 돌아갑니다. Kubernetes JSON 오류도 서버에서
백업 후 수정합니다. 서버 접근 권한과 검증된 백업을 유지하세요.

## 검증 범위

자동 테스트는 권한·CSRF·데모 차단, 저장/재시작 구분, revision 충돌, 인증서/경로 제한,
토큰 비노출과 모의 연결 검사를 검증합니다. 실제 Engine 4.5.6 및 실제 Kubernetes 연결은
운영 대상별로 TLS, 로그인, 읽기 권한, 토큰 교체, 재시작과 장애 복구를 검증해야 합니다.

개발 검증 명령:

```bash
# 저장소 루트의 Python 가상환경에서
python -m pytest -q tests
cd frontend
npm run build
# README의 로컬 데모 백엔드와 Vite 서버를 실행한 뒤
npm run test:ui
npm run test:integrations
```

연동 화면 브라우저 테스트는 데모의 실제 저장 차단과 가이드 표시를 확인하고,
관리자 화면의 입력/저장/재시작 안내/충돌 메시지는 가로챈 모의 API 응답으로 검증합니다.
실제 관리자 저장 로직은 Python 테스트의 격리된 임시 파일에서 검증합니다.
어떤 자동 테스트도 실제 운영 자격증명이나 설정 파일을 사용하지 않습니다.
