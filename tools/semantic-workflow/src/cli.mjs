import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, sanitize } from './common.mjs';
import { Sources, readSeeds, selectSeeds } from './sources.mjs';
import { State } from './state.mjs';
import { requestFor } from './model.mjs';
import { run, exportModel } from './runner.mjs';
import { serve } from './server.mjs';
import { PILOT } from './pilot.mjs';
import { pilotReport, revalidatePilot } from './review.mjs';

const home = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), command = args.shift() ?? 'help';
const options = {};
const flags = new Set(['offline', 'retry-failed', 'retry-uncertain']);
const values = new Set(['config', 'ids', 'limit', 'query', 'port']);
try {
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (flags.has(key)) options[key] = true;
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else throw Error(`UNKNOWN_OR_MISSING_OPTION:${key}`);
  }
  if (command === 'help' || command === '--help') {
    console.log('CDM pilot: pilot-prepare [--offline] | pilot-run [--ids ...] [--retry-failed] [--retry-uncertain] | pilot-report | pilot-revalidate\nLegacy: prepare [--ids ...] [--limit 20] [--query keyword] [--offline] | run [--ids ...] [--limit 20] [--retry-failed]\nstatus | export | serve [--port 8795]\nAll commands accept --config path. API credentials remain local. Browser review: /pilot');
  } else {
    const cfg = loadConfig(resolve(options.config ?? join(home, existsSync(join(home, 'config.local.json')) ? 'config.local.json' : 'config.example.json')));
    const state = new State(join(cfg.outputDirectory, 'state.sqlite'));
    const limit = Number(options.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error('INVALID_LIMIT');
    const ids = String(options.ids ?? '').split(',').filter(Boolean);
    if (options['retry-uncertain'] && (command !== 'pilot-run' || ids.length !== 1)) throw Error('MANUAL_RETRY_REQUIRES_ONE_EXPLICIT_PILOT_ID');
    let keepOpen = false;
    try {
      if (command === 'prepare' || command === 'pilot-prepare') {
        const all = readSeeds(cfg), selected = command === 'pilot-prepare' ? PILOT.map(p => {
          const seed = all.find(s => s.id === p.id); if (!seed) throw Error(`SEED_NOT_FOUND:${p.id}`); return seed;
        }) : selectSeeds(all, { ids, limit, query: options.query });
        if (!selected.length) throw Error('NO_MATCHING_SEEDS');
        const sources = new Sources(cfg, { graph: !options.offline });
        const packs = [];
        try {
          await sources.status();
          for (const seed of selected) { const pack = await sources.pack(seed, command === 'pilot-prepare' ? PILOT.find(p => p.id === seed.id) : null); packs.push(pack); console.log(JSON.stringify({ event: 'prepared', id: seed.id, evidence: pack.evidence.length, graphEvidence: pack.evidence.filter(e => e.kind === 'graph_bindings').length, chars: JSON.stringify(pack).length })); }
          await sources.verifyVersion();
        } finally { sources.close(); }
        const dir = join(cfg.outputDirectory, 'packs'); mkdirSync(dir, { recursive: true });
        for (const pack of packs) { state.savePack(pack); writeFileSync(join(dir, `${pack.hash}.json`), JSON.stringify(pack, null, 2)); }
        const inventory = all.map(s => ({ id: s.id, title: s.title, group: s.group, kind: s.kind, tables: s.tableNames }));
        writeFileSync(join(cfg.outputDirectory, 'inventory.json'), JSON.stringify(sanitize(inventory), null, 2));
        const plan = { inventoryCount: all.length, preparedCount: packs.length, noApiCalls: true, tokenEstimateMethod: 'UTF-8 bytes + message allowance + output cap, conservative admission only', packs: packs.map(p => ({ id: p.id, hash: p.hash, title: p.title, reservationTokens: requestFor(p, cfg).reserveTokens, gaps: p.gaps })) };
        writeFileSync(join(cfg.outputDirectory, 'plan.json'), JSON.stringify(plan, null, 2));
        console.log(JSON.stringify({ inventoryCount: all.length, preparedCount: packs.length, apiCalls: 0 }));
      } else if (command === 'run' || command === 'pilot-run') {
        const envFile = join(cfg.home, '.env.local');
        if (existsSync(envFile)) process.loadEnvFile(envFile);
        const packs = state.packs().filter(p => (!ids.length || ids.includes(p.id) || ids.includes(p.sourceId)) && (command !== 'pilot-run' || p.pilot)).sort((a, b) => (a.pilot?.order ?? 999) - (b.pilot?.order ?? 999));
        if (!packs.length) throw Error('NO_PREPARED_PACKS');
        if (command === 'pilot-run' && !ids.length && packs.length !== PILOT.length) throw Error('PREPARE_ALL_SEVEN_PILOT_INPUTS_FIRST');
        const report = await run(cfg, state, packs, { limit, retryFailed: options['retry-failed'], retryUncertain: options['retry-uncertain'], log: event => console.log(JSON.stringify(event)) });
        writeFileSync(join(cfg.outputDirectory, 'last-run.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        if (report.stopped) process.exitCode = report.stopped === 'budget' ? 2 : 1;
      } else if (command === 'pilot-revalidate') {
        console.log(JSON.stringify({ results: revalidatePilot(state), apiCalls: 0 }));
      } else if (command === 'pilot-report') {
        const report = pilotReport(state);
        writeFileSync(join(cfg.outputDirectory, 'pilot-report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report.summary, null, 2));
      } else if (command === 'status') {
        console.log(JSON.stringify({ usage: state.usage(), items: state.items().map(({ result, ...item }) => ({ ...item, entityCount: result?.entities?.length ?? 0, relationCount: result?.relations?.length ?? 0 })) }, null, 2));
      } else if (command === 'export') {
        const model = exportModel(state);
        writeFileSync(join(cfg.outputDirectory, 'semantic-model.json'), JSON.stringify(model, null, 2));
        writeFileSync(join(cfg.outputDirectory, 'candidates.json'), JSON.stringify(state.items(), null, 2));
        console.log(JSON.stringify({ acceptedEntities: model.entities.length, relations: model.relations.length, conflicts: model.conflicts.length, candidates: state.items().length }));
      } else if (command === 'serve') {
        const port = Number(options.port ?? 8795);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('INVALID_PORT');
        const server = serve(state, { port }); keepOpen = true;
        server.on('listening', () => console.log(`Semantic review: http://127.0.0.1:${server.address().port}`));
        server.on('error', () => { console.error('REVIEW_SERVER_START_FAILED'); state.close(); process.exitCode = 1; });
        process.on('SIGINT', () => server.close(() => { state.close(); process.exit(0); }));
      } else throw Error('UNKNOWN_COMMAND');
    } finally { if (!keepOpen) state.close(); }
  }
} catch (e) {
  console.error(JSON.stringify({ error: sanitize(e.message).slice(0, 1600) })); process.exitCode = 1;
}
