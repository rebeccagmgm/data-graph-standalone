// Isolated UI acceptance fixture; never reads or modifies the real workflow state/API configuration.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { State } from '../src/state.mjs';
import { PILOT, loadStandards, normalizePilot } from '../src/pilot.mjs';
import { serve } from '../src/server.mjs';
const dir = mkdtempSync(join(tmpdir(), 'semantic-pilot-ui-')), state = new State(join(dir, 'state.sqlite'));
const pack = { id: PILOT[0].id, sourceId: PILOT[0].sourceId, hash: 'ui-test-only', title: 'UI 测试样例', pilot: PILOT[0], standards: loadStandards(resolve(import.meta.dirname, '../../..')), assets: [{ id: 'fixture', table: 'test.synthetic_contract', identityStatus: 'unique_metadata_match_not_graph_verified', fields: [{ name: 'contract_id' }, { name: 'account_id' }] }], evidence: [{ id: 'fixture', kind: 'sql_excerpt', source: 'synthetic_test_not_business_evidence', content: 'UI 测试数据，无真实业务含义' }], gaps: ['仅 UI 测试样例，不能作为业务判断'] };
const result = normalizePilot({ entities: [{ id: 'Trade', standardRef: 'Trade', canonicalId: 'cdm:7.0.0:Trade', alignment: 'pending', name: 'Trade', definition: '', properties: [{ name: 'tradeIdentifier', type: 'TradeIdentifier', evidenceIds: ['fixture'] }], evidenceIds: ['fixture'], decision: 'new', evidenceStatus: 'supported', questions: [] }], relations: [], mappings: [{ entityId: 'Trade', assetId: 'fixture', scope: 'UI 合成样例范围', fields: [{ property: 'tradeIdentifier', field: 'contract_id' }], coverage: 'partial', note: '只覆盖标识值，未构造完整 CDM 实例', evidenceIds: ['fixture'] }], relationMappings: [], unmappedRelations: [{ id: 'fixture-link', name: '测试：内部合约账户关联', assetId: 'fixture', fromField: 'contract_id', toField: 'account_id', scope: 'UI 测试范围', reason: '样例没有付款职责证据，CDM 路径待定', evidenceIds: ['fixture'] }], classifications: [], gaps: [] }, pack);
state.savePack(pack); const id = state.reserve('fixture', pack.hash, 1, 10); state.finish(id, { status: 'success', usage: { total_tokens: 1 }, result });
const server = serve(state, { port: Number(process.argv[2] ?? 8796) });
server.on('listening', () => console.log(`UI_FIXTURE_READY:${server.address().port}`));
function stop() { server.close(() => { state.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
// Test-only server expires automatically; no persistent helper is left running.
setTimeout(stop, 15 * 60 * 1000).unref();
