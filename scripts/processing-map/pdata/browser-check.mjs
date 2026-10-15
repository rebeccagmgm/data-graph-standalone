import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sandboxPage, root } from "./browser-harness.mjs";
const { browser, page, errors, requests, at, go } = await sandboxPage(
  process.argv[2] ?? process.env.PLAYWRIGHT_NODE_MODULES,
);
const output = resolve(root, "tmp/processing-map-pdata");
await mkdir(output, { recursive: true });
const click = async (target, scope = "") =>
  page
    .locator(scope + '[data-route="' + target + '"]:visible')
    .first()
    .click();
try {
  const data = await page.evaluate(() => ({
    branches: DATA.branches,
    counts: DATA.counts,
  }));
  const names = new Set();
  assert.equal(await page.locator(".output-branch").count(), 9);
  for (const b of data.branches) {
    await click("branch/" + b.id, ".output-branch");
    await at("branch/" + b.id);
    assert.equal(
      await page.locator(".category-member").count(),
      b.tables.length,
    );
    const members = await page
      .locator(".category-member")
      .evaluateAll((xs) => xs.map((x) => x.dataset.member));
    assert.deepEqual(members.sort(), [...b.tables].sort());
    members.forEach((n) => names.add(n));
    assert.equal(
      await page.locator(".category-member .placement-status").count(),
      b.tables.length,
    );
    assert.equal(
      await page.locator('.graph-node[data-route^="part/"]').count(),
      0,
    );
    if (b.id !== "sales") {
      assert.ok(
        (await page.locator("#category-relationships .graph-node").count()) <=
          10,
        "category does not expand a task input inventory as the lesson",
      );
      const links = await page
        .locator("#category-relationships .graph-edge")
        .evaluateAll((xs) => xs.map((x) => [x.dataset.from, x.dataset.to]));
      assert.ok(
        links.every(
          ([a, c]) => a.startsWith("task:") !== c.startsWith("task:"),
        ),
        "category edges keep task-mediated evidence",
      );
    }
    await page.locator("#home").click();
  }
  assert.equal(names.size, 132);
  await click("branch/sales", ".output-branch");
  const stableURL = page.url();
  const map = page.locator("#category-relationships .flow-svg");
  const view = await map.getAttribute("viewBox");
  const trail = await page.locator("#breadcrumbs").innerText();
  await click("stages/105743", "#category-relationships .graph-node");
  assert.equal(page.url(), stableURL);
  assert.equal(
    await page.locator('.processing-prose[data-process="105743"]').count(),
    1,
  );
  await click(
    "table/pdata_n.t98_otc_comp_mng_rela_info",
    "#category-relationships .graph-node",
  );
  assert.equal(page.url(), stableURL);
  assert.equal(await map.getAttribute("viewBox"), view);
  assert.equal(await page.locator(".inline-result .prose-stage").count(), 5);
  assert.match(
    await page.locator(".inline-result .processing-prose").innerText(),
    /两次写入.*前三组.*分别.*空字符串/s,
  );
  assert.equal(
    await page.locator(".inline-result .prose-stage:visible").count(),
    5,
  );
  await page.locator(".inline-result .prose-graph summary").click();
  await page
    .locator('.inline-result .graph-node[data-node="fallback"]')
    .click();
  assert.equal(page.url(), stableURL);
  assert.match(
    await page.locator("#process-105743-fallback").innerText(),
    /COALESCE.*混合来源/s,
  );
  await page.locator("#process-105743-fallback .inline-sql summary").click();
  assert.equal(
    await page.locator("#process-105743-fallback .inline-sql[open]").count(),
    1,
  );
  assert.ok(
    (
      await page.locator("#process-105743-fallback .sql-scroll").innerText()
    ).includes("coalesce(ci.Inr_Org_Id_1, cpi.Inr_Org_Id_1)"),
  );
  assert.equal(await page.locator("#breadcrumbs").innerText(), trail);
  await page
    .locator("#process-105743-fallback")
    .screenshot({ path: resolve(output, "management-prose.png") });
  await click(
    "table/pdata_n.t98_otc_deri_comp_sale_adtnl_det",
    ".category-members ",
  );
  assert.equal(page.url(), stableURL);
  assert.equal(await page.locator(".inline-result .prose-stage").count(), 11);
  assert.match(
    await page.locator("#process-107491-info").innerText(),
    /没有把序列统一截到结束日/,
  );
  assert.match(
    await page.locator("#process-107491-ks_t").innerText(),
    /没有像 ks 那样向后展开/,
  );
  assert.equal(
    await page.locator("#process-107491-amount tbody tr").count(),
    4,
  );
  assert.match(
    await page.locator("#process-107491-write").innerText(),
    /Data_Etl_Date.*9月7日/s,
  );
  await page
    .locator("#process-107491-amount")
    .screenshot({ path: resolve(output, "daily-amount-prose.png") });
  await page.locator(".inline-result .prose-graph summary").click();
  for (const key of [
    "info",
    "evt",
    "his_dy",
    "ks",
    "ks_t",
    "nd",
    "prop",
    "fee",
    "amount",
    "write",
  ]) {
    await page
      .locator('.inline-result .graph-node[data-node="' + key + '"]')
      .click();
    await page
      .locator("#process-107491-" + key + " .inline-sql summary")
      .click();
    assert.ok(
      await page
        .locator("#process-107491-" + key + " .sql-line.highlight")
        .count(),
    );
    assert.equal(page.url(), stableURL);
  }
  for (const id of ["118143", "118141", "230202"]) {
    await click("task/" + id, "#category-relationships .graph-node");
    assert.equal(page.url(), stableURL);
    assert.match(
      await page.locator(".inline-result").innerText(),
      /一行代表什么.*日期怎样理解/s,
    );
  }
  assert.match(await page.locator(".inline-result").innerText(), /固定v2缺失/);
  for (const [a, b] of [
    ["base", "rev"],
    ["daily", "rev"],
    ["fee", "rev"],
    ["reward", "income"],
  ])
    assert.equal(
      await page
        .locator('.graph-edge[data-from="' + a + '"][data-to="' + b + '"]')
        .count(),
      1,
    );
  for (const [a, b] of [
    ["para", "income"],
    ["fee", "income"],
    ["mgmt", "daily"],
  ])
    assert.equal(
      await page
        .locator('.graph-edge[data-from="' + a + '"][data-to="' + b + '"]')
        .count(),
      0,
    );
  await page.locator('.graph-edge[data-from="base"][data-to="rev"]').focus();
  await page.keyboard.press("Enter");
  assert.match(
    await page.locator("#relation-evidence").innerText(),
    /T98_OTC_DERI_COMP_SALE_INFO/,
  );
  assert.equal(page.url(), stableURL);
  await click("branch/contract", ".learning-outline ");
  await page
    .getByRole("searchbox", { name: "查找本类结果" })
    .fill("t03_agt_rela_h");
  assert.equal(await page.locator(".category-member:visible").count(), 1);
  await click("table/pdata_n.t03_agt_rela_h", ".category-members ");
  const before = await page
    .locator(".inline-result .result-purpose")
    .innerText();
  await click("branch/lifecycle", ".learning-outline ");
  await click("table/pdata_n.t03_agt_rela_h", ".category-members ");
  assert.equal(
    await page.locator(".inline-result .result-purpose").innerText(),
    before,
  );
  await page.locator(".placement-evidence summary").click();
  assert.match(
    await page.locator(".placement-evidence").innerText(),
    /105061.*105063.*108070/s,
  );
  const relatedURL = page.url();
  await page
    .locator('.placement-evidence [data-route^="source/"]')
    .first()
    .click();
  assert.equal(page.url(), relatedURL);
  assert.match(await page.locator("#inline-evidence").innerText(), /分析依据/);
  await go("table/pdata_n.t98_otc_comp_mng_rela_info");
  assert.equal(await page.locator(".processing-prose").count(), 1);
  const tableURL = page.url();
  await page.locator('[data-reader-anchor="process-105743-pivot"]').click();
  assert.equal(page.url(), tableURL);
  for (const hash of [
    "incoming",
    "downstream",
    "unlinked",
    "boundary",
    "scope",
    "standards",
    "outputs",
  ]) {
    await go(hash);
    assert.doesNotMatch(await page.locator("h1").innerText(), /没有这个对象/);
  }
  await go("all-tables");
  await page.getByRole("button", { name: "再显示 30 项" }).click();
  assert.equal(await page.locator("tbody tr").count(), 60);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const hash of [
    "overview",
    "branch/sales",
    "branch/contract",
    "table/pdata_n.t98_otc_deri_comp_sale_adtnl_det",
  ]) {
    await go(hash);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      hash,
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const result = {
    result: "PASS",
    mode: "isolated Edge; no file URL or network",
    checks: [
      "PDATA categories and 132 members",
      "category relationships instead of status subpages",
      "same-page result, full prose, stages and SQL",
      "shared result identity",
      "parallel consumers and boundaries",
      "search and mobile",
    ],
    errors,
    requests,
  };
  await writeFile(
    resolve(output, "browser-check.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
