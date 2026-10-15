import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
export const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

export class PortalTransport {
  constructor(session, { businessErrorCode = () => 'PORTAL_BUSINESS_ERROR' } = {}) {
    this.session = session;
    this.businessErrorCode = businessErrorCode;
    this.cliPath = join(homedir(),'AppData/Roaming/npm/node_modules/@jackwener/opencli/dist/src/main.js');
    this.requestCount = 0;
  }
  async cli(...args) {
    let output;
    try { output = await exec(process.execPath,[this.cliPath,'browser',this.session,...args],
      {encoding:'utf8',maxBuffer:16*1024*1024,timeout:90000,windowsHide:true}); }
    catch { throw new Error('OPENCLI_EXECUTION_FAILED'); }
    let value;
    try { value = JSON.parse(output.stdout); } catch { throw new Error('OPENCLI_NON_JSON'); }
    if (value?.error) throw new Error('OPENCLI_' + String(value.error.code || 'ERROR').toUpperCase().replace(/[^A-Z0-9_]/g,''));
    return value;
  }
  async open() {
    await this.cli('open','https://data.gf.com.cn/portal/#/page/dataAssets/dataMap','--window','background');
    const module = await import(pathToFileURL(join(homedir(),'.opencli/shared/szdata-core/portal-shared.mjs')).href);
    this.portal = module.createPortalShared({portalApiBase:'https://data.gf.com.cn/portal/prod-api',
      governApiBase:'https://data.gf.com.cn/govern/prod-api',portalUrl:'https://data.gf.com.cn/portal/'});
    this.page = {evaluate:async script=>{
      const value = await this.cli('eval',script);
      const envelope = typeof value === 'string' ? JSON.parse(value) : value;
      if (envelope.status !== 200) throw new Error('HTTP_' + Number(envelope.status));
      const body = JSON.parse(envelope.body);
      if (body.code !== 0) throw new Error(this.businessErrorCode(body));
      return JSON.stringify(envelope);
    }};
  }
  async query(query, pageNo, pageSize=100) {
    if (!Number.isSafeInteger(pageNo) || pageNo < 1 || pageNo * pageSize > 10000) throw new Error('RESULT_WINDOW_EXCEEDED');
    const fields = {type:'003000',content:'',status:1,tempShow:0,highLight:0,searchWayType:0,...query,pageNo,pageSize};
    for (let attempt=0;attempt<4;attempt++) {
      this.requestCount++;
      let result, failure;
      try { result = await this.portal.postPortalFormObject(this.page,'/metaservice/metadataSearch/searchByEs',fields); }
      catch(error) { failure=error; }
      await sleep(1000 + Math.floor(Math.random()*501));
      if (!failure) return result;
      if (failure.message === 'HTTP_429' && attempt<3) { await sleep(30000 * 2**attempt); continue; }
      if (/^HTTP_5\d\d$/.test(failure.message) && attempt<2) { await sleep(5000 * 2**attempt); continue; }
      throw failure;
    }
  }
}
