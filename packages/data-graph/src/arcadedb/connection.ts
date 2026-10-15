import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type ArcadeDbPasswordSource =
  | { readonly kind: "ENVIRONMENT"; readonly variable: string }
  | { readonly kind: "FILE"; readonly path: string };

export interface ArcadeDbConnectionInput {
  /** HTTP origin, not a Bolt endpoint. Credentials must be supplied separately. */
  readonly uri: string;
  readonly username: string;
  readonly database: string;
  readonly passwordSource: ArcadeDbPasswordSource;
}

export interface GraphRecord {
  // Cypher result columns vary by query; consumers validate individual values.
  get(name: string): any;
}
export interface GraphQueryResult { readonly records: readonly GraphRecord[] }
export interface GraphTransaction {
  run(command: string, params?: Record<string, unknown>): Promise<GraphQueryResult>;
}
export interface GraphSession extends GraphTransaction {
  executeWrite<T>(work: (transaction: GraphTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface GraphConnection {
  session(options: { database: string }): GraphSession;
  close(): Promise<void>;
}

function bounded(value: string, code: string, maximum = 256): string {
  if (typeof value !== "string" || !value || value.trim() !== value ||
      value.length > maximum || /[\r\n\0]/u.test(value)) throw new Error(code);
  return value;
}

function origin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("ARCADEDB_URI_INVALID"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("ARCADEDB_URI_SCHEME_INVALID");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("ARCADEDB_URI_COMPONENT_INVALID");
  return url.origin;
}

function databaseName(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(value))
    throw new Error("ARCADEDB_DATABASE_INVALID");
  return value;
}

function password(source: ArcadeDbPasswordSource, environment: Readonly<Record<string, string | undefined>>): string {
  if (source.kind === "ENVIRONMENT") {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(source.variable)) throw new Error("ARCADEDB_PASSWORD_ENV_INVALID");
    const value = environment[source.variable];
    if (!value || value.length > 16384) throw new Error("ARCADEDB_PASSWORD_ENV_MISSING_OR_INVALID");
    return value;
  }
  try {
    const path = resolve(source.path), size = statSync(path).size;
    if (size < 1 || size > 16384) throw new Error();
    const value = readFileSync(path, "utf8").replace(/[\r\n]+$/u, "");
    if (!value) throw new Error();
    return value;
  } catch { throw new Error("ARCADEDB_PASSWORD_FILE_UNREADABLE_OR_INVALID"); }
}

function validateNumbers(value: unknown): void {
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
    throw new Error("ARCADEDB_UNSAFE_NUMBER");
  if (Array.isArray(value)) value.forEach(validateNumbers);
  else if (value && typeof value === "object") Object.values(value).forEach(validateNumbers);
}

/** Native ArcadeDB HTTP/JSON transport. No external database client is required. */
export async function openArcadeDbConnection(
  input: ArcadeDbConnectionInput,
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  } = {},
): Promise<{ readonly driver: GraphConnection; readonly database: string }> {
  const base = origin(input.uri), database = databaseName(input.database);
  const username = bounded(input.username, "ARCADEDB_USERNAME_INVALID");
  if (username.includes(":")) throw new Error("ARCADEDB_USERNAME_INVALID");
  const authorization = `Basic ${Buffer.from(`${username}:${password(input.passwordSource, options.environment ?? process.env)}`).toString("base64")}`;
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new Error("ARCADEDB_TIMEOUT_INVALID");
  let closed = false;
  const sessions = new Set<GraphSession>();

  async function request(action: string, body?: unknown, sessionId?: string): Promise<{response: Response; data: unknown}> {
    let response: Response;
    try {
      response = await fetchRequest(`${base}/api/v1/${action}/${encodeURIComponent(database)}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: {Authorization: authorization, "Content-Type": "application/json", ...(sessionId ? {"arcadedb-session-id":sessionId} : {})},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),
      });
    } catch {
      // Never retry writes or commits: the server may already have applied them.
      throw new Error(action === "commit" ? "ARCADEDB_COMMIT_OUTCOME_UNKNOWN" : "ARCADEDB_REQUEST_FAILED");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401 || response.status === 403 ? "ARCADEDB_AUTH_FAILED" : `ARCADEDB_HTTP_${response.status}`);
    }
    if (response.headers.has("arcadedb-session-expired")) {
      await response.body?.cancel(); throw new Error("ARCADEDB_SESSION_EXPIRED");
    }
    if (response.status === 204) return {response, data:null};
    let data: unknown;
    try { data = await response.json(); } catch { throw new Error("ARCADEDB_RESPONSE_INVALID"); }
    if (data && typeof data === "object" && ("error" in data || "exception" in data || "errors" in data))
      throw new Error("ARCADEDB_QUERY_FAILED");
    validateNumbers(data);
    return {response, data};
  }

  const driver: GraphConnection = {
    session({database: requested}) {
      if (closed) throw new Error("ARCADEDB_CONNECTION_CLOSED");
      if (requested !== database) throw new Error("ARCADEDB_DATABASE_MISMATCH");
      let sessionClosed = false, transactionRunning = false;
      let sessionId: string | undefined;
      const session: GraphSession = {
        async run(command, params = {}) {
          if (closed || sessionClosed) throw new Error("ARCADEDB_SESSION_CLOSED");
          if (typeof command !== "string" || !command.trim()) throw new Error("ARCADEDB_COMMAND_REQUIRED");
          validateNumbers(params);
          const {data} = await request("command", {language:"cypher", command, params, serializer:"record", limit:-1}, sessionId);
          if (!data || typeof data !== "object" || !("result" in data) || !Array.isArray(data.result))
            throw new Error("ARCADEDB_RESPONSE_INVALID");
          const records: GraphRecord[] = data.result.map((row: unknown) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("ARCADEDB_ROW_INVALID");
            const fields = row as Record<string, unknown>;
            return {get(name: string) {
              if (!Object.hasOwn(fields,name)) throw new Error("ARCADEDB_RESULT_COLUMN_MISSING");
              return fields[name];
            }};
          });
          return {records};
        },
        async executeWrite(work) {
          if (closed || sessionClosed) throw new Error("ARCADEDB_SESSION_CLOSED");
          if (transactionRunning) throw new Error("ARCADEDB_TRANSACTION_ALREADY_RUNNING");
          transactionRunning = true;
          try {
            const {response} = await request("begin");
            const id = response.headers.get("arcadedb-session-id");
            if (!id || !/^[\x21-\x7E]{1,512}$/u.test(id)) throw new Error("ARCADEDB_SESSION_ID_MISSING_OR_INVALID");
            sessionId = id;
            const result = await work({run:(command,params) => session.run(command,params)});
            if (closed || sessionClosed || !sessionId) throw new Error("ARCADEDB_SESSION_CLOSED");
            await request("commit", undefined, sessionId);
            sessionId = undefined;
            return result;
          } catch (error) {
            if (sessionId) {
              try { await request("rollback",undefined,sessionId); }
              catch { /* Preserve the original failure without exposing server diagnostics. */ }
              sessionId = undefined;
            }
            throw error;
          } finally { transactionRunning = false; }
        },
        async close() {
          if (sessionClosed) return;
          sessionClosed = true; sessions.delete(session);
          if (sessionId) {
            const id = sessionId; sessionId = undefined;
            await request("rollback",undefined,id);
          }
        },
      };
      sessions.add(session); return session;
    },
    async close() {
      closed = true;
      const results = await Promise.allSettled([...sessions].map(session => session.close()));
      if (results.some(result => result.status === "rejected")) throw new Error("ARCADEDB_CONNECTION_CLOSE_FAILED");
    },
  };
  return {driver, database};
}
