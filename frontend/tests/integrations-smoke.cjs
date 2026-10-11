const assert = require("node:assert/strict");
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OMA_CHROMIUM_EXECUTABLE || undefined,
    args: process.env.OMA_CHROMIUM_EXECUTABLE
      ? ["--no-sandbox", "--disable-dev-shm-usage"]
      : [],
  });
  try {
    const page = await browser.newPage({
        viewport: { width: 1440, height: 960 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const base = process.env.OMA_UI_TEST_URL || "http://127.0.0.1:5173";
    assert.equal(
      (await (await page.request.get(base + "/api/capabilities")).json()).demo,
      true,
      "Requires demo backend",
    );
    await page.goto(base);
    await page.getByLabel("사용자 이름", { exact: true }).fill("demo");
    await page.getByLabel("비밀번호", { exact: true }).fill("demo");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await page.getByRole("button", { name: "연동 설정", exact: true }).click();
    await page
      .getByText(
        "데모에서는 예시 입력만 가능하며 실제 저장·연결 검사는 차단됩니다.",
        { exact: true },
      )
      .waitFor();
    assert(
      await page
        .getByRole("button", { name: "Engine 설정 저장", exact: true })
        .isDisabled(),
    );
    assert(
      await page
        .getByRole("button", { name: "연결 확인", exact: true })
        .isDisabled(),
    );
    await page
      .getByRole("button", { name: "설정 가이드", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "1. 최초 관리자 로그인 준비", exact: true })
      .waitFor();
    // Admin forms use intercepted responses. This never grants admin rights or writes server configuration.
    const engine = {
      api_url: "https://engine.example/ovirt-engine/api",
      ca_file: "/etc/oma/credentials/engine-ca.pem",
      sso_token_url: "https://engine.example/ovirt-engine/sso/oauth/token",
      sso_scope: "ovirt-app-api",
      token_login: true,
    };
    let savedEngine = null,
      savedClusters = null;
    await page.route("**/api/integrations/status", (r) =>
      r.fulfill({ json: { can_edit: true, demo: false } }),
    );
    await page.route("**/api/integrations/settings", (r) =>
      r.fulfill({
        json: {
          engine,
          active_engine: engine,
          engine_revision: "revision1",
          clusters: [],
          clusters_revision: "revision2",
          restart_required: false,
          credential_root: "/etc/oma/credentials",
        },
      }),
    );
    await page.route("**/api/integrations/engine/check", (r) =>
      r.fulfill({
        json: {
          reachable: true,
          http_status: 401,
          authentication_checked: false,
        },
      }),
    );
    await page.route("**/api/integrations/engine", (r) => {
      savedEngine = r.request().postDataJSON();
      assert(r.request().headers()["x-csrf-token"]);
      return r.fulfill({
        json: { revision: "revision3", restart_required: true },
      });
    });
    await page.route("**/api/integrations/kubernetes/check", (r) =>
      r.fulfill({
        json: { reachable: true, checked_path: "/api/v1/namespaces/team/pods" },
      }),
    );
    await page.route("**/api/integrations/kubernetes", (r) => {
      savedClusters = r.request().postDataJSON();
      assert(r.request().headers()["x-csrf-token"]);
      return r.fulfill({
        json: { revision: "revision4", restart_required: false },
      });
    });
    await page.getByRole("button", { name: "OV-Works 홈" }).click();
    await page.getByRole("button", { name: "연동 설정", exact: true }).click();
    await page
      .getByLabel("Engine REST API URL", { exact: true })
      .fill("https://new.example/ovirt-engine/api");
    await page
      .getByLabel("SSO 토큰 URL", { exact: true })
      .fill("https://new.example/ovirt-engine/sso/oauth/token");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "OV-Works 홈" }).click();
    assert.equal(
      await page
        .getByLabel("Engine REST API URL", { exact: true })
        .inputValue(),
      "https://new.example/ovirt-engine/api",
    );
    await page.getByRole("button", { name: "연결 확인", exact: true }).click();
    await page
      .getByText(
        "TLS/HTTP 연결 성공 (HTTP 401). 계정 인증·SSO 검증은 아직 수행하지 않았습니다.",
        { exact: true },
      )
      .waitFor();
    await page
      .getByRole("button", { name: "Engine 설정 저장", exact: true })
      .click();
    await page
      .getByText(
        "Engine 설정 저장 완료. systemctl restart oma 실행 후 재로그인하세요.",
        { exact: true },
      )
      .waitFor();
    assert.equal(savedEngine.revision, "revision1");
    assert.equal(
      savedEngine.engine.api_url,
      "https://new.example/ovirt-engine/api",
    );
    await page
      .locator(".integration-tabs")
      .getByRole("button", { name: "Kubernetes 클러스터", exact: true })
      .click();
    await page
      .getByRole("button", { name: "클러스터 추가", exact: true })
      .click();
    await page.getByLabel("클러스터 ID", { exact: true }).fill("production");
    await page.getByLabel("표시 이름", { exact: true }).fill("Production");
    await page.getByLabel("추가할 사용자 이름").fill("operator@internal");
    await page
      .getByRole("button", { name: "사용자 추가", exact: true })
      .click();
    await page
      .getByLabel("허용 네임스페이스 (쉼표 구분)", { exact: true })
      .fill("team, apps");
    await page.getByLabel("Pod 로그", { exact: true }).check();
    await page.getByLabel("매핑할 노드 이름").fill("worker-1");
    await page.getByLabel("매핑할 VM UUID").fill("vm-123");
    await page.getByRole("button", { name: "매핑 추가", exact: true }).click();
    await page.getByRole("button", { name: "연결 확인", exact: true }).click();
    await page.getByText("목록 조회 성공:", { exact: false }).waitFor();
    await page
      .getByRole("button", { name: "전체 클러스터 저장", exact: true })
      .click();
    await page
      .getByText("Kubernetes 설정 저장 완료.", { exact: false })
      .waitFor();
    assert.equal(savedClusters.revision, "revision2");
    assert.deepEqual(
      savedClusters.clusters[0].users["operator@internal"].namespaces,
      ["team", "apps"],
    );
    assert.equal(
      savedClusters.clusters[0].users["operator@internal"].logs,
      true,
    );
    assert.equal(savedClusters.clusters[0].node_vm_map["worker-1"], "vm-123");
    // Stale editors must see a conflict rather than a successful save message.
    await page.route("**/api/integrations/kubernetes", (r) =>
      r.fulfill({
        status: 409,
        json: { detail: "Configuration changed; reload before saving" },
      }),
    );
    await page
      .getByRole("button", { name: "전체 클러스터 저장", exact: true })
      .click();
    await page
      .getByRole("alert")
      .getByText("Configuration changed; reload before saving", {
        exact: false,
      })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "Integration menu overflows mobile viewport",
    );
    assert.deepEqual(errors, []);
    console.log(
      "Integration UI passed: actual demo write denial, guide, mocked admin checks/save/restart notice, namespace permissions, VM mapping, revision conflict, mobile layout.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
