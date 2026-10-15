import { Strategy } from '@jackwener/opencli/registry';
import { createPortalShared } from '../../portal-shared.mjs';
import { SZDATA_PROD } from '../../envs.js';
import { queryFields, mapPage } from './catalog-core.mjs';

const directoryScript = `(() => {
  const roots = [], virtual = [], seen = new Set();
  function visit(v) {
    if (!v || seen.has(v)) return; seen.add(v);
    if (Array.isArray(v.$data?.classificationList)) roots.push(...v.$data.classificationList.filter(x => x?.classificationName && x?.uuid));
    if (Array.isArray(v.$data?.virtualDirectoryList)) virtual.push(...v.$data.virtualDirectoryList);
    (v.$children || []).forEach(visit);
  }
  visit(document.querySelector('#app')?.__vue__);
  return [...new Map(roots.map(x => [x.classificationName, x])).values()].map(x => ({
    name:x.classificationName.replace(/^分类_/, ''), path:x.classificationName, id:x.uuid,
    kind:virtual.some(v => v.classificationName === x.classificationName) ? 'virtual' : 'classification',
    extraDatabaseId:virtual.find(v => v.classificationName === x.classificationName)?.database || null
  }));
})()`;

async function directories(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = await page.evaluate(directoryScript);
    const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(rows) && rows.length) return rows;
    await page.wait(1);
  }
  throw new Error('CLASSIFICATION_DIRECTORY_UNAVAILABLE');
}

// PAGE_FETCH / DOM_STATE; internal-unstable. Reuses the observed portal request
// and live taxonomy controls because the existing table MCP omits these filters.
const base = {site:'szdata', domain:SZDATA_PROD.domain, strategy:Strategy.COOKIE, browser:true,
  access:'read', navigateBefore:SZDATA_PROD.portalUrl + '#/page/dataAssets/dataMap',
  siteSession:'persistent', defaultWindowMode:'background'};

export const classificationCommand = {...base, name:'classification-list',
  description:'列出数据地图当前分类目录（含虚拟目录）；不把目录命中数视为去重表数。',
  example:'opencli szdata classification-list -f json', args:[],
  columns:['name','path','kind','extraDatabaseId'], func:async page => directories(page)};

export const searchCommand = {...base, name:'catalog-search',
  description:'按分类、系统、物理数据库检索表目录；默认有效非临时表，单页校验，禁止超过一万条窗口。',
  example:'opencli szdata catalog-search --classification 按元数据分类 --page-size 20 -f json',
  args:[
    {name:'keyword',type:'string',default:'',help:'表关键词'},
    {name:'classification',type:'string',default:'',help:'classification-list 返回的 path，或分类名称'},
    {name:'system',type:'string',default:'',help:'所属系统精确标识；不是数据库类型'},
    {name:'database',type:'string',default:'',help:'数据库物理标识（库名@来源）；跨来源混入时报错'},
    {name:'page',type:'int',default:1,help:'页号，从 1 开始'},
    {name:'page-size',type:'int',default:20,help:'每页 1–100；page × page-size 不得超过 10000'}
  ], columns:['name','database','classifications','page','total','evidenceStatus'],
  func:async (page,args) => {
    const fields = queryFields(args);
    if (fields.classifications.length) {
      const root = (await directories(page)).find(x => fields.classifications[0] === x.path || fields.classifications[0].startsWith(x.path + '_'));
      if (!root) throw new Error('UNKNOWN_CLASSIFICATION');
      if (root.kind === 'virtual') {
        if (root.path !== fields.classifications[0] || !root.extraDatabaseId) throw new Error('UNSUPPORTED_VIRTUAL_CLASSIFICATION');
        fields.extraDatabaseId = root.extraDatabaseId;
      }
    }
    const shared = createPortalShared(SZDATA_PROD);
    const guardedPage = {evaluate:async script => {
      const raw = await page.evaluate(script);
      let envelope, body;
      try { envelope = JSON.parse(raw); } catch { throw new Error('INVALID_PORTAL_RESPONSE'); }
      if (envelope.status !== 200) throw new Error('HTTP_' + Number(envelope.status));
      try { body = JSON.parse(envelope.body); } catch { throw new Error('INVALID_PORTAL_RESPONSE'); }
      if (body.code !== 0) throw new Error('PORTAL_BUSINESS_ERROR');
      return raw;
    }};
    const data = await shared.postPortalFormObject(guardedPage, '/metaservice/metadataSearch/searchByEs', fields);
    const result = mapPage(data,fields);
    const metadata = {page:result.page,total:result.total,nextPage:result.nextPage,evidenceStatus:result.evidenceStatus};
    return result.records.length ? result.records.map(row => ({...row,...metadata})) : [{guid:null,...metadata}];
  }};
