export function matchGraphTables(rows, assets) {
  const norm = value => String(value ?? '').trim().toLowerCase();
  const index = new Map();
  for (const asset of assets) {
    const key = JSON.stringify([norm(asset.databaseType), norm(asset.qualifiedName)]);
    const matches = index.get(key) ?? [];
    matches.push(asset.guid);
    index.set(key, matches);
  }
  return rows.map(row => {
    const d = JSON.parse(row.detail);
    if (d.identityStatus !== 'CONFIRMED' || !d.platform || !d.dataSource || !d.qualifiedName)
      return {nodeId: row.id, status: 'UNCONFIRMED_IDENTITY'};
    const key = JSON.stringify([norm(d.platform), norm(d.qualifiedName) + '@' + norm(d.dataSource)]);
    const matches = index.get(key) ?? [];
    return {nodeId: row.id, status: matches.length === 1 ? 'MATCHED' : matches.length ? 'AMBIGUOUS' : 'NOT_IN_CATALOG', ...(matches.length === 1 ? {guid: matches[0]} : {})};
  });
}
