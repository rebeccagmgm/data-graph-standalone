import { createHash } from "node:crypto";
import { preferredRdbmsDataSourceFromTaskSource, type HoraeDatasourceIndex } from "./horae-datasource-cache.ts";

export function loaderProperty(log: string, key: string): string {
  const values = [...log.matchAll(/^\[INFO\] \[[^\r\n]+\] \[[^\r\n]+, AnyLoader\][ \t]+\$\{([^}]+)\}[ \t]*=[ \t]*([^\r\n]*)/gm)]
    .filter(m => m[1] === key).map(m => m[2]!.trim()
      .replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
  if (!values.length || new Set(values).size !== 1) throw new Error("WRITE_COLUMNS_LOADER_PROPERTY_NOT_PROVEN");
  return values[0]!;
}

/** Match actual loader endpoint against the existing datasource directory.
 * No connection strings or credentials are persisted in the Pack. */
export function verifyRuntimeTargetIdentity(log: string, target: unknown, index: HoraeDatasourceIndex | undefined): string {
  const t = target as {platform?: string;dataSource?: string};
  if (!t?.platform || !t.dataSource || !index) throw new Error("WRITE_COLUMNS_TARGET_IDENTITY_INCOMPLETE");
  const jdbc = loaderProperty(log, "target.db.connection.string");
  const match = jdbc.match(/^jdbc:(mysql|postgresql):\/\/([^/:?;]+):(\d+)\/([^?;\s]+)/i) ??
    jdbc.match(/^jdbc:(oracle):thin:@(?:\/\/)?([^/:?;]+):(\d+)[/:]([^?;\s]+)/i);
  if (!match) throw new Error("WRITE_COLUMNS_RUNTIME_TARGET_UNSUPPORTED");
  const [, driver, host, port, service] = match;
  const normalize = (value: string) => value.toLowerCase().replace(/^postgresql$|^postgres$/, "postgre");
  const platform = normalize(t.platform);
  if (normalize(driver!) !== platform && !(platform === "starrocks" && driver!.toLowerCase() === "mysql"))
    throw new Error("WRITE_COLUMNS_RUNTIME_TARGET_MISMATCH");
  const matches = [...index.byServerTag.values()].filter(e => normalize(e.serverType) === platform &&
    e.host?.toLowerCase() === host!.toLowerCase() && Number(e.port) === Number(port) && e.service.toLowerCase() === service!.toLowerCase());
  const identities = new Set(matches.map(e => preferredRdbmsDataSourceFromTaskSource(e.serverTag,index)).filter(Boolean));
  if (identities.size !== 1 || !identities.has(t.dataSource)) throw new Error("WRITE_COLUMNS_RUNTIME_TARGET_MISMATCH");
  return createHash("sha256").update(JSON.stringify([platform,t.dataSource,host!.toLowerCase(),Number(port),service!.toLowerCase()])).digest("hex");
}
