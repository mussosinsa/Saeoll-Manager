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
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
OMA_DEMO=true OMA_COOKIE_SECURE=false OMA_AUDIT_PATH=/tmp/oma-dev-audit.jsonl uvicorn app:app --host 127.0.0.1 --port 8088
```
In a second terminal: `cd frontend && npm install && npm run dev`, browse to `http://127.0.0.1:5173` and use `demo/demo`. Never expose demo mode externally.

## Known limitations
- No actual OV-Works 4.5.6 Engine integration test or production React build completed here.
- In-memory sessions/rate limits are not HA-ready.
- Hash-chain full-file verification per append is O(n) and not suitable for high-volume production.
- SSO, RBAC, VM console and writes remain unverified/disabled.
