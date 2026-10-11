# OMA v1.8 — Audit checkpoint and independent verification

Development/read-only continuation of v1.7 for OV-Works Engine 4.5.6. The React UI and existing Engine REST API read paths are retained. VM mutations remain **blocked**; real SSO/RBAC and browser console are **not** verified.

## v1.8 changes
- HMAC-SHA256 signed audit checkpoint: count + final hash of an independently verified SHA-256 chain.
- CLI to create and verify checkpoints, including detection of log truncation and replacement with a new internally valid chain.
- Atomic checkpoint replacement, fsync, restrictive 0600 permissions; re-anchoring refuses a broken previous checkpoint.
- Additional tests for checkpoint integrity, truncation, rewriting and weak keys.

## Example — isolated test environment
```bash
python3.11 -m pytest -q tests
# create a dedicated binary signing key; keep it in a separate protected trust domain
install -d -m 0700 /root/oma-anchor
python3.11 -c 'import secrets;open("/root/oma-anchor/key", "wb").write(secrets.token_bytes(32))'
chmod 0600 /root/oma-anchor/key
python3.11 tools/audit_anchor.py create --log /var/log/oma/audit.jsonl --anchor /root/oma-anchor/checkpoint.json --key-file /root/oma-anchor/key
python3.11 tools/audit_anchor.py verify --log /var/log/oma/audit.jsonl --anchor /root/oma-anchor/checkpoint.json --key-file /root/oma-anchor/key
```

**Security boundary:** Keeping the key/checkpoint under `/root` on the **same host** is only a local test. For actual tamper resistance, protect signing keys in an external KMS/HSM or separately managed host and transmit checkpoints to an independent immutable WORM/SIEM store. An attacker who controls both the signing key and anchor can forge a checkpoint. HMAC does not provide public verifiability. Checkpoint creation is not atomic with concurrent appends, so run it in a controlled maintenance window or use a snapshot; verification permits new records appended after the anchored prefix. Existing v1.7 audit chains are compatible.

## Demo
```bash
python3.11 -m venv backend/.venv && source backend/.venv/bin/activate
pip install -r backend/requirements.txt
OMA_DEMO=true OMA_COOKIE_SECURE=false OMA_AUDIT_PATH=/tmp/oma-dev-audit.jsonl uvicorn backend.app:app --host 127.0.0.1 --port 8088
```
In a second terminal: `cd frontend && npm install && npm run dev`, browse to `http://127.0.0.1:5173` and use `demo/demo`. Never expose demo mode externally.

## Known limitations
- No actual OV-Works 4.5.6 Engine integration test completed here; the React production build is validated locally.
- In-memory sessions/rate limits are not HA-ready.
- Hash-chain full-file verification per append is O(n) and not suitable for high-volume production.
- SSO, RBAC, VM console and writes remain unverified/disabled.

## Kubernetes 현황 관리

상단 **Kubernetes** 버튼으로 여러 클러스터의 노드, Pod·컨테이너, 워크로드, 이벤트, 로그와
선택적 ConfigMap·Secret 메타데이터·RBAC·메트릭을 조회합니다. VM↔노드 연결도 지원합니다.
현재 조회 전용이며 데모 세션에서는 샘플 데이터를 사용합니다.
실제 클러스터 등록, 인증·권한, 배포 예시와 제한 사항은 [Kubernetes 운영 안내](docs/kubernetes.md)를 참고하세요.

## 관리 콘솔 UI

서버 트리·자원별 메뉴·상세 패널·하단 이벤트를 갖춘 통합 콘솔입니다.
검색, 화면 밀도/갱신 설정, Kubernetes 상세·로그, 모바일 배치를 지원합니다.
[화면 구성 및 UI 테스트 안내](docs/ui-console.md)를 참고하세요.
