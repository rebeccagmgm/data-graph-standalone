/** One real-browser acceptance run. The local analysis service must already be running. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const options = { baseUrl: 'http://127.0.0.1:8768/', output: 'artifacts/inventory-map/analysis-browser', playwrightRoot: process.env.PLAYWRIGHT_NODE_MODULES || '' };
const keys = { '--base-url': 'baseUrl', '--output': 'output', '--playwright-root': 'playwrightRoot' };
for (let i = 2; i < process.argv.length; i += 2) {
  if (!keys[process.argv[i]] || !process.argv[i + 1]) throw new Error(`Unknown or incomplete option: ${process.argv[i]}`);
  options[keys[process.argv[i]]] = process.argv[i + 1];
}
const base = new URL(options.baseUrl), output = resolve(options.output);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a local service');
await mkdir(output, { recursive: true });
const { chromium } = options.playwrightRoot ? await import(pathToFileURL(resolve(options.playwrightRoot, 'playwright/index.mjs')).href) : await import('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const report = { startedAt: new Date().toISOString(), checks: [], observations: {}, screenshots: [], consoleErrors: [], externalRequests: [], failedRequests: [], apiFailures: [] };
page.on('pageerror', (error) => report.consoleErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
page.on('request', (request) => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== base.origin) report.externalRequests.push(request.url()); });
page.on('requestfailed', (request) => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') report.failedRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }); });
page.on('response', (response) => { if (response.status() >= 400) report.apiFailures.push({ path: new URL(response.url()).pathname, status: response.status() }); });

class AnalysisPage {
  constructor(browserPage) { this.page = browserPage; this.view = null; }
  async settled() {
    await this.page.waitForFunction(() => document.querySelector('#busy')?.hidden);
    assert.equal(await this.page.locator('#error-banner').isVisible(), false, 'No visible query error');
  }
  async viewAction(action) {
    const response = this.page.waitForResponse((item) => new URL(item.url()).pathname === '/api/analysis-view');
    await action();
    const result = await (await response).json();
    assert.notEqual(result.ok, false, 'View query succeeds');
    this.view = result.data || result;
    await this.page.waitForFunction((id) => document.querySelector('#scene .node.focused')?.getAttribute('data-node-id') === id, this.view.focus.id);
    await this.settled();
    return this.view;
  }
  async home() { return this.viewAction(() => this.page.goto(base.href)); }
  async clickNode(id) {
    const node = this.page.locator('[data-node-id]').filter({ has: this.page.locator('title') });
    const target = node.and(this.page.locator(`[data-node-id="${id}"]`));
    return this.viewAction(async () => { await target.focus(); await this.page.keyboard.press('Enter'); });
  }
  async search(q, kind = '', schema = '') {
    const initial = this.page.waitForResponse((item) => new URL(item.url()).pathname === '/api/analysis-search');
    await this.page.locator(kind === 'schema' ? '#browse-schemas' : '#open-search').click();
    await initial;
    await this.settled();
    await this.page.locator('#object-search').fill(q);
    if (kind && kind !== 'schema') await this.page.locator('#kind-filter').selectOption(kind);
    if (kind !== 'schema') await this.page.locator('#schema-filter').fill(schema);
    const response = this.page.waitForResponse((item) => new URL(item.url()).pathname === '/api/analysis-search' && new URL(item.url()).searchParams.get('q') === q);
    await this.page.locator('#search-form button[type="submit"]').click();
    const result = await (await response).json();
    await this.settled();
    return (result.data || result).items;
  }
  async searchResult(id) { return this.viewAction(() => this.page.locator(`[data-result="${id}"]`).click()); }
  async screenshot(name, area = 'top') {
    if (area === 'analysis') await this.page.locator('#analysis').scrollIntoViewIfNeeded();
    else if (area === 'panel') await this.page.locator('.evidence-tabs').scrollIntoViewIfNeeded();
    else await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.screenshot({ path: resolve(output, `${name}.png`) });
    report.screenshots.push(`${name}.png`);
  }
  async noOverflow() { assert.equal(await this.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); }
}
const map = new AnalysisPage(page);
const check = async (name, action) => {
  const start = performance.now();
  try { await action(); report.checks.push({ name, status: 'PASS', elapsedMs: Math.round(performance.now() - start) }); }
  catch (error) {
    const screenshot = `failure-${report.checks.length + 1}.png`;
    await page.screenshot({ path: resolve(output, screenshot), fullPage: true }).catch(() => {});
    report.checks.push({ name, status: 'FAIL', elapsedMs: Math.round(performance.now() - start), error: error.message, screenshot });
  }
};

try {
  await check('default sales table, inline task expansion and camera history', async () => {
    const initial = await map.home();
    assert.match(initial.focus.qualifiedName, /pdata_n\.t98_otc_deri_comp_sale_info/i);
    assert.equal(initial.writers.length, 4);
    assert.equal(await page.locator('#inspector').count(), 0, 'No sidebar detail UI');
    assert.equal(await page.locator('#metric-tasks').count(), 0, 'No inventory dashboard');
    await map.screenshot('sales-table-default');
    await page.locator('#zoom-in').click();
    const camera = await page.locator('#scene').getAttribute('transform');
    const result = await map.clickNode('task:86840');
    assert.equal(result.sceneRootId, initial.sceneRootId);
    assert.ok(result.nodes.length > initial.nodes.length);
    for (const writer of ['task:86840', 'task:86841', 'task:86842', 'task:220650']) assert.ok(result.nodes.some((node) => node.id === writer), `${writer} remains in scene`);
    const state = await page.evaluate(() => history.state.entry);
    assert.ok(state.expanded.includes('task:86840'));
    report.observations.expansion = { initialNodes: initial.nodes.length, expandedNodes: result.nodes.length, rootPreserved: true };
    await map.screenshot('task-86840-in-place');
    await map.viewAction(() => page.locator('#back').click());
    assert.equal(await page.locator('#scene').getAttribute('transform'), camera, 'Back restores the exact prior camera');
    assert.equal((await page.evaluate(() => history.state.entry)).expanded.length, 0);
  });

  await check('init_nom_prin four branches, configuration partitions and accurate SQL lines', async () => {
    const initial = await map.home();
    const field = initial.fields.items.find((item) => item.name.toLowerCase() === 'init_nom_prin');
    assert.ok(field?.id);
    const view = await map.viewAction(() => page.locator(`[data-field="${field.id}"]`).click());
    assert.equal(view.sceneRootId, initial.sceneRootId);
    assert.equal(view.focus.kind, 'field');
    assert.equal(view.writers.length, 4);
    assert.equal(await page.locator('#tab-writers').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#panel-writers .writer-card').count(), 4);
    for (const writer of view.writers) {
      const card = page.locator(`[data-writer-id="${writer.id}"]`);
      assert.ok(writer.expressions.some((item) => item.outputName.toLowerCase() === 'init_nom_prin'));
      assert.match(await card.innerText(), /配置分区/);
      assert.match(await card.innerText(), /不认定实际运行/);
      const partition = writer.partition.flat().find((item) => item.grp_id);
      assert.ok(partition?.grp_id);
      assert.match(await card.innerText(), new RegExp(`grp_id: ${partition.grp_id}`));
      for (const expression of writer.expressions) {
        assert.ok((await card.locator('pre').allTextContents()).includes(expression.text));
        assert.ok((await card.innerText()).includes(`绑定状态：${expression.bindingStatus || '未记录'}`));
        for (const input of expression.inputs) assert.ok((await card.innerText()).includes(input.occurrenceStatus || '未记录'));
      }
    }
    report.observations.principal = { nodes: view.nodes.length, edges: view.edges.length, writers: view.writers.map((writer) => ({ id: writer.id, partition: writer.partition, expressions: writer.expressions.map((item) => ({ text: item.text, line: item.sourceLine, endLine: item.sourceEndLine, slot: item.sqlSlot, occurrenceStatuses: item.inputs.map((input) => input.occurrenceStatus) })) })) };
    await map.screenshot('principal-field-map');
    await map.screenshot('principal-four-branches', 'analysis');
    const writer = view.writers.find((item) => item.id === 'task:86840'), expression = writer.expressions.find((item) => item.outputName.toLowerCase() === 'init_nom_prin');
    const link = page.locator(`[data-writer-id="${writer.id}"] .source-lines`).first();
    assert.equal(Number(await link.getAttribute('data-line')), expression.sourceLine);
    assert.notEqual(expression.sourceLine, expression.sourceStart, 'Line number is not the character offset');
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/analysis-sql');
    await link.click();
    const reply = await response, sql = (await reply.json()).data;
    assert.equal(new URL(reply.url()).searchParams.get('slot'), expression.sqlSlot);
    assert.equal(sql.lineStart, expression.sourceLine);
    assert.ok(sql.available && sql.sql.length > 20);
    await page.locator('.sql-code').waitFor();
    assert.equal(Number(await page.locator('.sql-line-number').first().innerText()), expression.sourceLine);
    assert.match(await page.locator('.sql-code').innerText(), /Init_Nom_Prin/i);
    await map.screenshot('principal-sql-lines', 'panel');
    if (sql.nextLine != null) {
      const next = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/analysis-sql');
      await page.locator('#sql-next').click();
      const reply2 = await next;
      assert.equal(new URL(reply2.url()).searchParams.get('slot'), expression.sqlSlot);
      await map.settled();
      assert.equal(Number(await page.locator('.sql-line-number').first().innerText()), sql.nextLine);
    }
  });

  await check('task 107491 public knowledge remains distinct from execution proof', async () => {
    await map.home();
    const view = await map.clickNode('task:107491');
    assert.ok(view.knowledge?.body || view.knowledge?.summary);
    await page.locator('#tab-knowledge').click();
    assert.ok((await page.locator('#panel-knowledge').innerText()).length > 150);
    assert.ok((await page.locator('.knowledge-boundary').innerText()).length > 10);
    await map.screenshot('task-107491-knowledge', 'analysis');
  });

  await check('schema pdata_n has a visible paginated object directory', async () => {
    const found = await map.search('pdata_n', 'schema');
    assert.ok(found.some((item) => item.id === 'schema:pdata_n'));
    const view = await map.searchResult('schema:pdata_n');
    assert.equal(view.focus.kind, 'schema');
    assert.ok(view.members.total > view.members.items.length);
    await page.locator('#browse-current-schema').waitFor({ state: 'visible' });
    await map.screenshot('schema-pdata-n');
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/analysis-search');
    await page.locator('#browse-current-schema').click();
    await response;
    await map.settled();
    assert.equal(await page.locator('#schema-filter').inputValue(), 'pdata_n');
    const firstCount = await page.locator('#search-results .object-card').count();
    await page.locator('#search-more').waitFor({ state: 'visible' });
    const more = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/analysis-search');
    await page.locator('#search-more').click();
    await more;
    await map.settled();
    assert.ok(await page.locator('#search-results .object-card').count() > firstCount);
    const ids = await page.locator('#search-results .object-card').evaluateAll((items) => items.map((item) => item.dataset.result));
    assert.equal(ids.length, new Set(ids).size);
    report.observations.schemaDirectory = { total: view.members.total, initiallyDrawn: view.members.items.length, pagedCards: ids.length };
    await map.screenshot('schema-object-cards');
  });

  await check('definition candidates and catalog-only object boundaries', async () => {
    const items = await map.search('fdm_titans_pvt_prd_valu_eday');
    const dataset = items.find((item) => item.id.startsWith('dataset:') && item.schemaName === 'dm_cstd_n');
    assert.ok(dataset);
    const view = await map.searchResult(dataset.id);
    assert.ok(view.definitionCandidates.some((item) => item.match === 'NAME_ONLY_CANDIDATE'));
    await page.locator('.definition-candidates > summary').click();
    assert.match(await page.locator('.definition-candidates').innerText(), /同名候选 · 非同实例认定/);
    assert.ok(await page.locator('.definition-record .field-table tbody tr').count() > 0);
    await page.locator('.definition-preview > summary').first().click();
    assert.match(await page.locator('.definition-preview pre').first().innerText(), /CREATE\s+TABLE/i);
    await map.screenshot('definition-candidate', 'panel');
    const definitionResponse = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/analysis-sql');
    await page.locator('[data-definition-sql]').first().click();
    const definition = (await (await definitionResponse).json()).data;
    assert.ok(definition.available && definition.sql.length > 100);
    assert.equal(definition.source.kind, 'CATALOG_DEFINITION');
    await page.locator('.sql-code').waitFor();
    assert.equal(await page.locator('.sql-toolbar .label-text').innerText(), '元数据定义原文');
    await map.screenshot('definition-full-sql', 'panel');
    const again = await map.search('fdm_titans_pvt_prd_valu_eday');
    const core = again.find((item) => item.id.startsWith('catalog:hive-core:') && item.schemaName === 'dm_cstd_n');
    assert.ok(core);
    const coreView = await map.searchResult(core.id);
    assert.equal(coreView.fields.items.length, 0);
    assert.match(await page.locator('#panel-fields').innerText(), /仅收录对象清单/);
    await map.screenshot('catalog-only-boundary', 'analysis');
  });

  await check('inventory-only task 68275 explicitly exposes the processing gap', async () => {
    const items = await map.search('68275', 'task');
    assert.ok(items.some((item) => item.id === 'task:68275'));
    const view = await map.searchResult('task:68275');
    assert.match(await page.locator('#observations').innerText(), /尚无已索引的加工证据/);
    assert.match(await page.locator('#observations').innerText(), /不能用调度关系补作 SQL 血缘/);
    assert.equal(view.edges.length, 0);
    await map.screenshot('inventory-task-gap', 'analysis');
  });

  await check('mobile discovery, reading, and no page overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await map.home();
    await map.noOverflow();
    await map.screenshot('mobile-map');
    await page.locator('#tab-writers').click();
    await map.screenshot('mobile-evidence', 'panel');
    await map.noOverflow();
    await map.search('nothing-matches-this-object-zzzz');
    assert.match(await page.locator('#search-results').innerText(), /没有匹配的对象/);
    await map.noOverflow();
    await map.search('pdata_n', 'schema');
    await map.screenshot('mobile-schema-search');
  });

  await check('no console failures or external requests', async () => {
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.failedRequests, []);
    assert.deepEqual(report.externalRequests, []);
    assert.deepEqual(report.apiFailures, []);
  });
} finally {
  await context.tracing.stop({ path: resolve(output, 'trace.zip') });
  await browser.close();
}
report.finishedAt = new Date().toISOString();
report.status = report.checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, checks: report.checks, observations: report.observations }));
process.exitCode = report.status === 'PASS' ? 0 : 1;
