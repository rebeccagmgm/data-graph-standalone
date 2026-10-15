export function summarizeValues(key, values) {
  if (!Array.isArray(values) || values.some(x => typeof x !== 'string')) throw new Error('INVALID_PARTITION_VALUES');
  const unique = [...new Set(values)].sort();
  const dateKey = /date|日期|(^|_)(dt|day|month|year)(_|$)/i.test(key);
  const dates = unique.map(x => {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(x);
    if (!m) return null;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    const ms = Date.parse(iso + 'T00:00:00Z');
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0,10) === iso ? ms : null;
  });
  let grain = 'NOT_CLASSIFIED', omit = false;
  if (dateKey && unique.length >= 3 && dates.every(x => x !== null)) {
    const sorted = dates.toSorted((a,b) => a-b);
    const gaps = sorted.slice(1).map((x,i) => (x-sorted[i])/86400000);
    const months = sorted.map(x => {const d=new Date(x);return d.getUTCFullYear()*12+d.getUTCMonth();});
    const days = sorted.map(x => new Date(x).getUTCDate());
    const monthEnds = sorted.every(x => new Date(x+86400000).getUTCDate()===1);
    if (months.every((x,i)=>i===0 || x>months[i-1]) && (days.every(x=>x===days[0]) || monthEnds)) grain='MONTH_OR_COARSER_OBSERVED';
    else if (gaps.some(x=>x===1)) {grain='DAY_VALUES_OBSERVED';omit=true;}
    else grain='DATE_GRAIN_UNCERTAIN';
  } else if (dateKey) grain='DATE_GRAIN_UNCERTAIN';
  return {returnedCount:values.length,distinctCount:unique.length,grain,
    valueMode:omit?'DATE_SUMMARY':'FULL_RETURNED_VALUES',
    min:unique[0]??null,max:unique.at(-1)??null,values:omit?null:unique,
    completeness:'UNVERIFIED_ENDPOINT_TOTAL',
    note:omit?'Observed consecutive day values; this does not prove daily production cadence.':null};
}
