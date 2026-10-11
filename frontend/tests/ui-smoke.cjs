// Run against the local demo backend and Vite server. No production mutations.
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
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const base = process.env.OMA_UI_TEST_URL || "http://127.0.0.1:5173";
    const capabilities = await page.request.get(base + "/api/capabilities");
    assert.equal(
      (await capabilities.json()).demo,
      true,
      "UI smoke requires a demo server",
    );
    await page.goto(base);
    await page.getByLabel("사용자 이름", { exact: true }).fill("demo");
    await page.getByLabel("비밀번호", { exact: true }).fill("demo");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await page.locator(".resource-card").first().waitFor();
    await page
      .locator(".resource-card")
      .first()
      .getByText("3", { exact: true })
      .waitFor();
    if (process.env.OMA_UI_SCREENSHOTS)
      await page.screenshot({
        path: process.env.OMA_UI_SCREENSHOTS + "/dashboard.png",
      });
    await page.getByLabel("전체 자원 검색").fill("app-server");
    await page
      .locator("main")
      .getByRole("button", { name: "app-server", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "자원 메뉴" })
      .getByRole("button", { name: "디스크", exact: true })
      .click();
    await page.getByText("system-disk", { exact: true }).waitFor();
    await page
      .getByRole("navigation", { name: "자원 메뉴" })
      .getByRole("button", { name: "네트워크 인터페이스", exact: true })
      .click();
    await page
      .locator(".child-details h3")
      .getByText("eth0", { exact: true })
      .waitFor();
    await page
      .getByRole("navigation", { name: "자원 메뉴" })
      .getByRole("button", { name: "요약", exact: true })
      .click();
    assert(
      await page
        .getByRole("button", { name: "시작", exact: true })
        .isDisabled(),
    );
    if (process.env.OMA_UI_SCREENSHOTS)
      await page.screenshot({
        path: process.env.OMA_UI_SCREENSHOTS + "/vm.png",
      });
    await page
      .getByRole("button", { name: "화면 설정", exact: true })
      .first()
      .click();
    await page.getByLabel("목록 밀도").selectOption("comfortable");
    await page.getByLabel("Engine 자동 새로 고침").selectOption("0");
    await page.getByLabel("하단 이벤트 창 표시").uncheck();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "닫기", exact: true })
      .last()
      .click();
    assert.equal(await page.locator(".event-dock").count(), 0);
    await page.reload();
    await page.locator(".console.comfortable").waitFor();
    assert.equal(await page.locator(".event-dock").count(), 0);
    await page.getByLabel("이벤트 창 표시 전환").click();
    await page.getByRole("button", { name: "조회 기록", exact: true }).click();
    await page
      .locator(".dock-table")
      .getByText("Engine 인벤토리 조회", { exact: true })
      .first()
      .waitFor();
    await page
      .locator(".top-actions")
      .getByRole("button", { name: "Kubernetes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "document-search", exact: true })
      .click();
    await page.getByRole("button", { name: "로그 조회", exact: true }).click();
    await page
      .getByText("Demo log: service ready; no live workload connected.", {
        exact: true,
      })
      .waitFor();
    if (process.env.OMA_UI_SCREENSHOTS)
      await page.screenshot({
        path: process.env.OMA_UI_SCREENSHOTS + "/kubernetes.png",
      });
    await page
      .getByRole("navigation", { name: "Kubernetes 관리 대상" })
      .getByRole("button", { name: "노드", exact: true })
      .click();
    await page.getByRole("button", { name: "worker-1", exact: true }).click();
    await page
      .getByRole("button", {
        name: "이 노드의 Pod 조회 (선택한 네임스페이스)",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "document-parser", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "portal", exact: true }).count(),
      0,
    );
    await page
      .getByRole("navigation", { name: "Kubernetes 관리 대상" })
      .getByRole("button", { name: "Secret 메타데이터", exact: true })
      .click();
    await page
      .getByRole("button", { name: "registry-credentials", exact: true })
      .waitFor();
    assert(
      !(await page.locator("body").innerText()).includes("never-return-this"),
    );
    await page
      .getByRole("navigation", { name: "Kubernetes 관리 대상" })
      .getByRole("button", { name: "Pod CPU · 메모리", exact: true })
      .click();
    await page
      .getByText("메트릭 API가 제공되지 않습니다.", { exact: false })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("관리 대상", { exact: true }).selectOption("pods");
    await page
      .getByRole("button", { name: "document-search", exact: true })
      .waitFor();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      "mobile page overflows horizontally",
    );
    if (process.env.OMA_UI_SCREENSHOTS)
      await page.screenshot({
        path: process.env.OMA_UI_SCREENSHOTS + "/mobile.png",
        fullPage: true,
      });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "OV-Works 홈" }).click();
    // An unavailable resource must not be presented as a successful zero count.
    await page.route("**/api/inventory/hosts", (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Test Engine unavailable" }),
      }),
    );
    await page.getByLabel("Engine 새로 고침").click();
    await page
      .getByText("물리 호스트 — Error: Test Engine unavailable", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page.locator(".resource-card").nth(1).locator("strong").innerText(),
      "—",
    );
    await page.unroute("**/api/inventory/hosts");
    await page.getByTitle("로그아웃", { exact: true }).click();
    await page.getByLabel("비밀번호", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("비밀번호", { exact: true }).inputValue(),
      "",
    );
    assert.deepEqual(errors, []);
    console.log(
      "UI smoke passed: login, search, VM details, preferences, events, Kubernetes logs/drilldown/metrics, mobile layout, failure state, logout.",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
