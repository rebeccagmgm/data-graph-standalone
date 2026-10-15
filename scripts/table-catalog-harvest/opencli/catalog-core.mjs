export function queryFields(args = {}) {
  const page = Number(args.page ?? 1), size = Number(args['page-size'] ?? 20);
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(size) || page < 1 || size < 1 || size > 100 || page * size > 10000) throw new Error('RESULT_WINDOW_EXCEEDED');
  const value = key => {
    const text = String(args[key] ?? '').trim();
    if (text.length > 500 || /[\u0000-\u001f]/.test(text)) throw new Error('INVALID_FILTER');
    return text;
  };
  const classification = value('classification');
  const database = value('database');
  if (database && !database.includes('@')) throw new Error('DATABASE_QUALIFIED_ID_REQUIRED');
  return {type:'003000', status:1, tempShow:0, highLight:0, searchWayType:0,
    pageNo:page, pageSize:size, content:value('keyword'),
    classifications:classification ? [classification.startsWith('分类_') ? classification : '分类_' + classification] : [],
    businessSystem:value('system') ? [value('system')] : [], dataBaseIds:database ? [database] : []};
}

export function mapPage(data, fields) {
  if (!data || !Array.isArray(data.records) || !Number.isSafeInteger(data.totalResultNum) || data.totalResultNum < 0 || data.pageNo !== fields.pageNo || data.pageSize !== fields.pageSize) throw new Error('INVALID_PAGE_ENVELOPE');
  const expected = Math.min(fields.pageSize, Math.max(0, data.totalResultNum - (fields.pageNo - 1) * fields.pageSize));
  if (data.records.length !== expected) throw new Error('PAGE_LENGTH_MISMATCH');
  const ids = new Set();
  const records = data.records.map(row => {
    if (!row.guid || ids.has(row.guid) || row.metadataType !== '003000') throw new Error('INVALID_OR_DUPLICATE_TABLE');
    ids.add(row.guid);
    const paths = row.classificationList ?? [];
    if (!Array.isArray(paths) || paths.some(x => typeof x !== 'string')) throw new Error('INVALID_CLASSIFICATION');
    if (fields.dataBaseIds.length && !fields.dataBaseIds.includes(row.parentQualifiedName)) throw new Error('DATABASE_SCOPE_MISMATCH');
    if (!fields.extraDatabaseId && fields.classifications.length && !paths.some(x => x === fields.classifications[0] || x.startsWith(fields.classifications[0] + '_'))) throw new Error('CLASSIFICATION_SCOPE_MISMATCH');
    const clean = x => String(x ?? '').replace(/<[^>]*>/g, '');
    return {guid:row.guid, name:clean(row.name), database:clean(row.dbName), qualifiedName:row.qualifiedName,
      parentQualifiedName:row.parentQualifiedName, type:row.typeName, description:clean(row.comment), classifications:paths};
  });
  return {page:data.pageNo, pageSize:data.pageSize, total:data.totalResultNum, returned:records.length,
    hasMore:fields.pageNo * fields.pageSize < data.totalResultNum,
    nextPage:fields.pageNo * fields.pageSize < data.totalResultNum && (fields.pageNo + 1) * fields.pageSize <= 10000 ? fields.pageNo + 1 : null,
    resultWindow:10000, snapshot:'live-page-only', evidenceStatus:records.length ? 'PAGE_VALIDATED' : 'EMPTY_RESULT', records};
}
