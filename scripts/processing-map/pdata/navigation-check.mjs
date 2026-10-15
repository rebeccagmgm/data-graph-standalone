import assert from "node:assert/strict";
import { sandboxPage } from "./browser-harness.mjs";
const { browser, page, errors, requests, at, go } = await sandboxPage(
  process.argv[2] ?? process.env.PLAYWRIGHT_NODE_MODULES,
);
try {
  await page.locator('.output-branch[data-route="branch/sales"]').click();
  await at("branch/sales");
  const graph = page.locator("#category-relationships .flow-svg");
  await page
    .locator('#category-relationships [data-graph-action="in"]')
    .click();
  const box = await graph.getAttribute("viewBox");
  await page
    .getByRole("searchbox", { name: "查找本类结果" })
    .fill("sale_adtnl_det");
  await page.locator(".category-member:visible button").click();
  await page.locator(".processing-prose .prose-graph summary").click();
  await page.locator('.inline-result .graph-node[data-node="amount"]').click();
  await page.locator("#process-107491-amount .inline-sql summary").click();
  const currentURL = page.url(),
    currentTrail = await page.locator("#breadcrumbs").innerText();
  assert.equal(currentURL.endsWith("#branch/sales"), true);
  const paneBox = await page
    .locator(".inline-result .flow-svg")
    .getAttribute("viewBox");
  await page.locator(".inline-result .placement-evidence summary").click();
  await page
    .locator('.inline-result .placement-evidence [data-route^="source/"]')
    .first()
    .click();
  assert.equal(page.url(), currentURL);
  assert.match(await page.locator("#inline-evidence").innerText(), /分析依据/);
  await page.locator('.top-actions [data-route="scope"]').click();
  assert.notEqual(page.url(), currentURL);
  await page.locator("#back").click();
  await at("branch/sales");
  assert.equal(await graph.getAttribute("viewBox"), box);
  assert.equal(
    await page.getByRole("searchbox", { name: "查找本类结果" }).inputValue(),
    "sale_adtnl_det",
  );
  assert.equal(
    await page.locator('.processing-prose[data-process="107491"]').count(),
    1,
  );
  assert.equal(
    await page.locator("#process-107491-amount .inline-sql[open]").count(),
    1,
  );
  assert.match(await page.locator("#inline-evidence").innerText(), /分析依据/);
  assert.equal(
    await page.locator(".inline-result .flow-svg").getAttribute("viewBox"),
    paneBox,
  );
  assert.equal(await page.locator("#breadcrumbs").innerText(), currentTrail);
  await page.locator("#forward").click();
  assert.notEqual(page.url(), currentURL);
  await page.goBack();
  await at("branch/sales");
  await page
    .locator('.inline-result .prose-graph [data-graph-action="fullscreen"]')
    .click();
  const nav = await page.locator(".navigation").boundingBox(),
    full = await page.locator(".graph-expanded").boundingBox();
  assert.ok(full.y >= nav.y + nav.height);
  await page
    .locator('.graph-expanded [data-graph-action="fullscreen"]')
    .press("Escape");
  assert.equal(await page.locator(".graph-expanded").count(), 0);
  await page.locator("#home").click();
  assert.equal(await page.locator("#breadcrumbs [data-visit]").count(), 0);
  await page.locator('[data-route="incoming"]').click();
  await page.locator(".flow-row").filter({ hasText: "odata_n_tit" }).click();
  await page.getByRole("searchbox").fill("105529");
  await page.locator('[data-route="task/105529"]').click();
  await page.locator("#back").click();
  await at("tasks");
  assert.equal(await page.getByRole("searchbox").inputValue(), "105529");
  assert.match(await page.locator("[data-count]").innerText(), /共 212 项/);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    JSON.stringify({
      result: "PASS",
      checks: [
        "same-category result and SQL stay in place",
        "selection, filter, stage graph and disclosure restoration",
        "back and forward",
        "fullscreen and home",
        "original task search restoration",
      ],
    }),
  );
} finally {
  await browser.close();
}
