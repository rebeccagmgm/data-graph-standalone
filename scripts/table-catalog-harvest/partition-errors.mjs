const missingTypeMessage = '查询异常Cannot invoke "String.startsWith(String)" because "typeName" is null';

export function partitionBusinessErrorCode(body) {
  if (body?.code === 1 && body.msg === '查询异常null') return 'SOURCE_PARTITION_QUERY_NULL';
  return body?.code === 1 && body.msg === missingTypeMessage
    ? 'SOURCE_METADATA_TYPE_MISSING' : 'PORTAL_BUSINESS_ERROR';
}

export async function runPartitionTable(action, onMissingMetadata) {
  try { return await action(); }
  catch (error) {
    if (!['SOURCE_METADATA_TYPE_MISSING','SOURCE_PARTITION_QUERY_NULL'].includes(error?.message)) throw error;
    await onMissingMetadata(error.message);
    return 'BLOCKED';
  }
}
