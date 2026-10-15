/**
 * Repeatable local-browser acceptance checks for the inventory map.
 * Start server.mjs first. No packages are downloaded by this script.
 * node scripts/inventory-map/browser-check.mjs --playwright-root <node_modules>
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const options = {
  baseUrl: "http://127.0.0.1:8768/",
  output: "artifacts/inventory-map/browser",
  playwrightRoot: process.env.PLAYWRIGHT_NODE_MODULES || "",
  repeat: 1,
};
const argumentNames = new Map([
  ["--base-url", "baseUrl"],
  ["--output", "output"],
  ["--playwright-root", "playwrightRoot"],
  ["--repeat", "repeat"],
]);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = argumentNames.get(process.argv[i]);
  if (!key || !process.argv[i + 1])
    throw new Error(`Unknown or incomplete option: ${process.argv[i]}`);
  options[key] =
    key === "repeat" ? Number(process.argv[i + 1]) : process.argv[i + 1];
}
assert.ok(
  Number.isInteger(options.repeat) &&
    options.repeat >= 1 &&
    options.repeat <= 10,
  "repeat must be 1–10",
);
const base = new URL(options.baseUrl);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname),
  "Use a local map service",
);
const output = resolve(options.output);
await mkdir(output, { recursive: true });
const playwright = options.playwrightRoot
  ? await import(
      pathToFileURL(resolve(options.playwrightRoot, "playwright/index.mjs"))
        .href
    )
  : await import("playwright");
const browser = await playwright.chromium.launch({
  channel: "msedge",
  headless: true,
});
const report = {
  baseUrl: base.href,
  startedAt: new Date().toISOString(),
  runs: [],
  limitations: [],
};

class InventoryMapPage {
  constructor(page) {
    this.page = page;
  }
  async settled() {
    await this.page.waitForFunction(
      () => document.querySelector("#busy")?.hidden,
    );
    assert.equal(
      await this.page.locator("#error-banner").isVisible(),
      false,
      "No UI query error",
    );
  }
  async overview(width = 1440, height = 900) {
    await this.page.setViewportSize({ width, height });
    await this.page.goto(base.href);
    await this.page.locator("#scene .node").first().waitFor();
    await this.settled();
    await this.page.locator("#fit").click();
  }
  async screenshot(name, fullPage = false) {
    await this.page.screenshot({
      path: resolve(output, `${name}.png`),
      fullPage,
    });
  }
  async panel(expected) {
    await this.page.locator("#inspector").waitFor({ state: "visible" });
    await this.page.waitForFunction(
      (text) =>
        document.querySelector("#panel-content")?.textContent.includes(text),
      expected,
    );
    await this.settled();
  }
  async close() {
    await this.page.locator("#panel-close").click();
    await this.page.locator("#inspector").waitFor({ state: "hidden" });
  }
  async task(id) {
    await this.page
      .getByRole("searchbox", { name: "搜索任务", exact: true })
      .fill(id);
    await this.page
      .getByRole("button", { name: "查找 ↗", exact: true })
      .click();
    await this.page.locator(`#panel-content [data-task="${id}"]`).waitFor();
    await this.page.locator(`#panel-content [data-task="${id}"]`).click();
    await this.panel(`任务 ${id}`);
    await this.page.locator("#task-sql").waitFor();
  }
  async noOverflow() {
    assert.equal(
      await this.page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "No horizontal page overflow",
    );
  }
}

try {
  for (let run = 1; run <= options.repeat; run++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const map = new InventoryMapPage(page);
    const errors = [],
      external = [],
      failedRequests = [],
      apiTimings = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("request", (request) => {
      if (
        /^https?:/.test(request.url()) &&
        new URL(request.url()).origin !== base.origin
      )
        external.push(request.url());
    });
    page.on("requestfailed", (request) => {
      if (request.failure()?.errorText !== "net::ERR_ABORTED")
        failedRequests.push({
          url: request.url(),
          error: request.failure()?.errorText,
        });
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/api/")) {
        response
          .json()
          .then((body) =>
            apiTimings.push({
              command: new URL(response.url()).pathname.slice(5),
              elapsedMs: body.elapsedMs,
              ok: body.ok,
            }),
          )
          .catch(() => {});
      }
    });
    const result = {
      run,
      checks: [],
      screenshots: [],
      observations: {},
      errors,
      external,
      failedRequests,
      apiTimings,
    };
    const check = async (name, action) => {
      const start = performance.now();
      try {
        await action();
        result.checks.push({
          name,
          status: "PASS",
          elapsedMs: Math.round(performance.now() - start),
        });
      } catch (error) {
        const filename = `run-${run}-failure-${result.checks.length + 1}`;
        await map.screenshot(filename, true).catch(() => {});
        result.checks.push({
          name,
          status: "FAIL",
          elapsedMs: Math.round(performance.now() - start),
          error: error.message,
          screenshot: `${filename}.png`,
        });
      }
    };
    const shot = async (name) => {
      if (run !== 1) return;
      await map.screenshot(name);
      result.screenshots.push(`${name}.png`);
    };
    await check(
      "full inventory and five stage cards at 1440 × 900",
      async () => {
        await map.overview();
        assert.equal(
          await page.locator("#metric-tasks").innerText(),
          "114,007",
        );
        assert.equal(await page.locator("#scene .node").count(), 5);
        assert.equal(await page.locator("#scene .edge").count(), 8);
        result.observations.metrics = await page
          .locator(".metrics")
          .innerText();
        result.observations.overviewCounts = await page
          .locator("#map-counts")
          .innerText();
        await map.noOverflow();
        await shot("overview-1440");
        await page
          .locator("#scene .node")
          .first()
          .click({ position: { x: 40, y: 45 } });
        await map.panel("查看全部阶段任务");
        await page
          .getByRole("button", { name: "查看全部阶段任务", exact: true })
          .click();
        await map.panel("个库存任务");
        assert.ok(
          (await page.locator("#panel-content [data-task]").count()) > 0,
        );
        await map.close();
      },
    );
    await check(
      "aggregate stage edge exposes real task pairs and back navigation",
      async () => {
        await map.overview();
        await page
          .getByRole("button", { name: "全部阶段流向", exact: true })
          .click();
        await map.panel("19 条跨阶段流向");
        assert.equal(
          await page.locator("#panel-content [data-from]").count(),
          19,
        );
        await page.locator("#panel-content [data-from]").last().click();
        await map.panel("对去重任务依赖");
        assert.ok(
          (await page.locator("#panel-content .evidence-row").count()) > 0,
        );
        await map.close();
        await page.locator("#scene .edge").first().focus();
        await page.keyboard.press("Enter");
        await map.panel("对去重任务依赖");
        assert.ok(
          (await page.locator("#panel-content .evidence-row").count()) > 0,
        );
        await page.locator("#panel-content [data-task]").first().click();
        await map.panel("沿这个任务继续看");
        await page.locator("#panel-back").click();
        await map.panel("对去重任务依赖");
        await map.close();
      },
    );
    await check(
      "PDATA_N directory search, actual topic neighborhood, members and flows",
      async () => {
        await map.overview();
        const regionsResponse = page.waitForResponse(
          (response) =>
            response.url().includes("/api/regions?") &&
            response.url().includes("q=PDATA_N"),
        );
        await page
          .getByRole("searchbox", { name: "搜索主题", exact: true })
          .fill("PDATA_N");
        const found = (await (await regionsResponse).json()).data.items;
        await map.settled();
        result.observations.pdataSearchResults = found.map(
          (item) => item.label,
        );
        if (!found.some((item) => item.label === "PDATA_N")) {
          const limitation =
            "PDATA_N is not a cached topic; directory search matches PDATA_NEWS_N and PDATA_NEWS_TEST. Topic grouping is not schema grouping.";
          if (!report.limitations.includes(limitation))
            report.limitations.push(limitation);
        }
        await page
          .locator('#region-list [data-region="topic:PDATA_NEWS_N"]')
          .click();
        await page.waitForFunction(
          () =>
            document.querySelector("#map-title").textContent === "PDATA_NEWS_N",
        );
        await map.settled();
        assert.match(
          await page.locator("#map-subtitle").innerText(),
          /5,333 个库存任务/,
        );
        await shot("pdata-topic");
        await page.locator("#view-members").click();
        await map.panel("5,333 个库存任务");
        await page
          .getByRole("textbox", { name: "成员搜索", exact: true })
          .fill("no-matching-task-zzzz");
        await page.getByRole("button", { name: "筛选", exact: true }).click();
        await map.panel("没有匹配任务");
        await map.close();
        await page.locator("#view-flows").click();
        await map.panel("对去重任务依赖");
        assert.ok(
          (await page.locator("#panel-content .evidence-row").count()) > 0,
        );
        await map.close();
        await page.locator("#home").click();
        await page.waitForFunction(() =>
          document
            .querySelector("#map-kicker")
            .textContent.includes("全量总览"),
        );
      },
    );
    await check(
      "task 209119 upstream and bidirectional bounded local paths",
      async () => {
        await map.overview();
        await map.task("209119");
        await page
          .getByRole("button", { name: "上游路径", exact: true })
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector("#map-subtitle")
            .textContent.includes("向上游展开"),
        );
        await map.settled();
        const upstreamNodes = await page.locator("#scene .node").count();
        assert.ok(upstreamNodes > 1 && upstreamNodes <= 60);
        result.observations.task209119UpstreamNodes = upstreamNodes;
        await shot("task-209119-upstream");
        await page.locator("#view-members").click();
        await map.panel("任务 209119");
        await page
          .getByRole("button", { name: "双向一层", exact: true })
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector("#map-subtitle")
            .textContent.includes("双向展开"),
        );
        await map.settled();
        result.observations.task209119BothNodes = await page
          .locator("#scene .node")
          .count();
        assert.ok(result.observations.task209119BothNodes <= 60);
        await shot("task-209119-both");
        await page.goBack();
        await page.waitForFunction(() =>
          document
            .querySelector("#map-subtitle")
            .textContent.includes("向上游展开"),
        );
        await map.settled();
      },
    );
    await check(
      "task 107491 fixed SQL, pagination and public knowledge",
      async () => {
        await map.overview();
        await map.task("107491");
        await page
          .getByRole("button", { name: "读取 SQL ↗", exact: true })
          .click();
        await map.panel("任务 107491 · SQL");
        const sql = await page.locator(".sql").innerText();
        assert.ok(
          sql.length > 100 && /select|insert|with/i.test(sql),
          "SQL body is readable",
        );
        result.observations.sqlInitialCharacters = sql.length;
        await shot("sql-107491");
        await page.getByRole("button", { name: "下一段", exact: true }).click();
        await map.panel("第 121");
        assert.notEqual(await page.locator(".sql").innerText(), sql);
        await page.locator("#panel-back").click();
        await map.panel("沿这个任务继续看");
        await page
          .getByRole("button", { name: "公共知识 ↗", exact: true })
          .click();
        await map.panel("按计提日期展开");
        assert.ok(
          (await page.locator(".knowledge-text").innerText()).length > 100,
        );
        await shot("knowledge-107491");
        await page.keyboard.press("Escape");
        await page.locator("#inspector").waitFor({ state: "hidden" });
      },
    );
    await check(
      "high-degree task 68275 stays within 60 nodes and 160 edges",
      async () => {
        await map.overview();
        await map.task("68275");
        await page
          .getByRole("button", { name: "双向两层", exact: true })
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector("#map-subtitle")
            .textContent.includes("任务 68275"),
        );
        await map.settled();
        const nodes = await page.locator("#scene .node").count(),
          edges = await page.locator("#scene .edge").count();
        assert.ok(nodes > 1 && nodes <= 60);
        assert.ok(edges <= 160);
        assert.match(
          await page.locator("#map-boundary").innerText(),
          /有界局部结果/,
        );
        result.observations.highDegreeTask = {
          nodes,
          edges,
          boundary: await page.locator("#map-boundary").innerText(),
        };
      },
    );
    await check(
      "1920 × 1080 and mobile discovery and detail panel",
      async () => {
        await map.overview(1920, 1080);
        await map.noOverflow();
        await shot("overview-1920");
        await map.overview(390, 844);
        await map.noOverflow();
        await shot("mobile-overview");
        await page
          .getByRole("searchbox", { name: "搜索主题", exact: true })
          .fill("no-such-topic-zzzz");
        await page.getByText("没有匹配主题", { exact: true }).waitFor();
        await page
          .getByRole("searchbox", { name: "搜索主题", exact: true })
          .fill("PDATA_N");
        await page
          .locator('#region-list [data-region="topic:PDATA_NEWS_N"]')
          .waitFor({ state: "visible" });
        await shot("mobile-directory");
        await page
          .locator('#region-list [data-region="topic:PDATA_NEWS_N"]')
          .click();
        await page.waitForFunction(
          () =>
            document.querySelector("#map-title").textContent === "PDATA_NEWS_N",
        );
        await page.locator("#view-members").click();
        await map.panel("5,333 个库存任务");
        await map.noOverflow();
        await shot("mobile-members");
        await map.close();
      },
    );
    await check(
      "no console errors, failed requests or external requests",
      async () => {
        assert.deepEqual(errors, []);
        assert.deepEqual(failedRequests, []);
        assert.deepEqual(external, []);
        assert.ok(
          apiTimings.length > 0 && apiTimings.every((item) => item.ok),
          "Every observed API request succeeds",
        );
      },
    );
    result.status = result.checks.every((item) => item.status === "PASS")
      ? "PASS"
      : "FAIL";
    await context.tracing.stop({
      path: resolve(output, `run-${run}-trace.zip`),
    });
    await context.close();
    report.runs.push(result);
    console.log(
      JSON.stringify({
        run,
        status: result.status,
        checks: result.checks.map(({ name, status, error }) => ({
          name,
          status,
          error,
        })),
      }),
    );
  }
} finally {
  await browser.close();
}
report.finishedAt = new Date().toISOString();
report.status = report.runs.every((run) => run.status === "PASS")
  ? "PASS"
  : "FAIL";
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );
await writeFile(
  resolve(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  resolve(output, "junit.xml"),
  `<?xml version="1.0" encoding="UTF-8"?><testsuites>${report.runs.map((run) => `<testsuite name="inventory-map-run-${run.run}" tests="${run.checks.length}" failures="${run.checks.filter((check) => check.status === "FAIL").length}">${run.checks.map((check) => `<testcase name="${escape(check.name)}" time="${check.elapsedMs / 1000}">${check.status === "FAIL" ? `<failure message="${escape(check.error)}"/>` : ""}</testcase>`).join("")}</testsuite>`).join("")}</testsuites>`,
);
await writeFile(
  resolve(output, "report.html"),
  `<!doctype html><meta charset="utf-8"><title>Inventory map browser checks</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#142b39}table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #ccd5db;text-align:left}img{max-width:100%;border:1px solid #ccd5db}code{white-space:pre-wrap}.FAIL{color:#a31c2b}.PASS{color:#13724c}</style><h1>Browser checks: ${report.status}</h1><p>${escape(report.startedAt)} — ${escape(report.finishedAt)}</p>${report.limitations.map((text) => `<p>${escape(text)}</p>`).join("")}${report.runs.map((run) => `<h2>Run ${run.run}: ${run.status}</h2><table>${run.checks.map((check) => `<tr><td>${escape(check.name)}</td><td class="${check.status}">${check.status}</td><td>${check.elapsedMs} ms${check.error ? `<br><code>${escape(check.error)}</code>` : ""}</td></tr>`).join("")}</table>`).join("")}<h2>Screenshots</h2>${report.runs
    .flatMap((run) => run.screenshots)
    .map(
      (file) =>
        `<p><a href="${file}">${file}</a></p><img loading="lazy" src="${file}" alt="${file}">`,
    )
    .join("")}`,
);
process.exitCode = report.status === "PASS" ? 0 : 1;
