import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { openArcadeDbConnection } from "./connection.ts";
import { AssetGraphStore } from "../asset-graph/store.ts";

test("native HTTP sends parameterized Cypher, authenticates and commits one session", async () => {
  const calls: Array<{ path: string; session?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Basic " + Buffer.from("reader:test-secret").toString("base64"));
    let text = "";
    for await (const chunk of request) text += chunk;
    calls.push({path:request.url!, session:request.headers["arcadedb-session-id"] as string | undefined, body:text ? JSON.parse(text) : {}});
    if (request.url!.includes("/begin/")) {
      response.writeHead(204, {"arcadedb-session-id":"AS-test"}); response.end();
    } else if (request.url!.includes("/command/")) {
      response.setHeader("Content-Type","application/json"); response.end(JSON.stringify({result:[{count:2,node:{label:"合成示例"}}]}));
    } else { response.writeHead(204); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const connection = await openArcadeDbConnection({uri:`http://127.0.0.1:${address.port}`,username:"reader",database:"synthetic_probe",passwordSource:{kind:"ENVIRONMENT",variable:"TEST_SECRET"}}, {environment:{TEST_SECRET:"test-secret"}});
  try {
    const session = connection.driver.session({database:connection.database});
    const result = await session.executeWrite(async transaction => transaction.run("RETURN $name AS node",{name:"合成示例"}));
    assert.equal(result.records[0]!.get("count"),2);
    assert.deepEqual(result.records[0]!.get("node"),{label:"合成示例"});
    assert.deepEqual(calls.map(call => call.path),["/api/v1/begin/synthetic_probe","/api/v1/command/synthetic_probe","/api/v1/commit/synthetic_probe"]);
    assert.equal(calls[1]!.session,"AS-test"); assert.equal(calls[2]!.session,"AS-test");
    assert.deepEqual(calls[1]!.body.params,{name:"合成示例"});
    assert.equal(calls[1]!.body.language,"cypher");
    assert.equal(calls[1]!.body.limit,-1);
    await session.close();
    const failed = connection.driver.session({database:connection.database});
    await assert.rejects(failed.executeWrite(async () => {throw new Error("ROLLBACK_TEST");}),/ROLLBACK_TEST/);
    assert.ok(calls.at(-1)!.path.includes("/rollback/"));
    await failed.close();
    assert.equal(calls.filter(call => call.path.includes("/commit/")).length,1);
  } finally {
    await connection.driver.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("invalid URLs and embedded credentials reject before any network request", async () => {
  for (const uri of ["bolt://localhost:7687","http://user:secret@localhost:2480","http://localhost:2480/path","http://localhost:2480?secret=1"]) {
    await assert.rejects(openArcadeDbConnection({uri,username:"reader",database:"synthetic_probe",passwordSource:{kind:"ENVIRONMENT",variable:"TEST_SECRET"}},{environment:{TEST_SECRET:"test-secret"}}),/ARCADEDB_URI_/);
  }
});

test("HTTP and business errors are bounded and never expose credentials or query text", async () => {
  for (const [status,body] of [[401,{error:"test-secret"}],[200,{error:"private-query"}],[200,{result:"invalid"}]] as const) {
    const connection = await openArcadeDbConnection({uri:"http://127.0.0.1:2480",username:"reader",database:"synthetic_probe",passwordSource:{kind:"ENVIRONMENT",variable:"TEST_SECRET"}},{environment:{TEST_SECRET:"test-secret"},fetch:async () => new Response(JSON.stringify(body),{status})});
    const session = connection.driver.session({database:connection.database});
    await assert.rejects(session.run("private-query"), error => {
      assert.match(String(error),/ARCADEDB_/); assert.doesNotMatch(String(error),/test-secret|private-query/); return true;
    });
    await connection.driver.close();
  }
});

test("failed commands roll back without retrying the callback or committing", async () => {
  const paths: string[] = [];
  const connection = await openArcadeDbConnection({uri:"http://127.0.0.1:2480",username:"reader",database:"synthetic_probe",passwordSource:{kind:"ENVIRONMENT",variable:"TEST_SECRET"}},{environment:{TEST_SECRET:"test-secret"},fetch:async url => {
    const pathname = new URL(String(url)).pathname; paths.push(pathname);
    if (pathname.includes("/begin/")) return new Response(null,{status:204,headers:{"arcadedb-session-id":"AS-test"}});
    if (pathname.includes("/command/")) return new Response(JSON.stringify({error:"failure"}),{status:500});
    return new Response(null,{status:204});
  }});
  const session = connection.driver.session({database:connection.database});
  let attempts = 0;
  await assert.rejects(session.executeWrite(async transaction => {attempts++; return transaction.run("CREATE (n)");}),/ARCADEDB_HTTP_500/);
  assert.equal(attempts,1);
  assert.deepEqual(paths.map(p=>p.split('/')[3]),["begin","command","rollback"]);
  await connection.driver.close();
});

test("graph store consumes native numeric counts without database-driver integer objects", async () => {
  const connection = await openArcadeDbConnection({uri:"http://127.0.0.1:2480",username:"reader",database:"synthetic_probe",passwordSource:{kind:"ENVIRONMENT",variable:"TEST_SECRET"}},{environment:{TEST_SECRET:"test-secret"},fetch:async (_url,init) => {
    const body = JSON.parse(String(init!.body));
    assert.equal(body.params.graphId,"synthetic_graph");
    const result = body.command.includes("RETURN n.kind") ? [{kind:"TASK",count:2}] : [{kind:"VALUE",count:3}];
    return new Response(JSON.stringify({result}));
  }});
  try {
    const store = new AssetGraphStore(connection.driver,connection.database,"synthetic_graph");
    assert.deepEqual(await store.counts(),{nodes:{TASK:2},edges:{VALUE:3}});
  } finally { await connection.driver.close(); }
});

test("lost commit responses are explicit and are never retried", async () => {
  let commits = 0;
  const connection = await openArcadeDbConnection({uri:"http://127.0.0.1:2480",username:"reader",database:"synthetic_probe",passwordSource:{kind:"ENVIRONMENT",variable:"TEST_SECRET"}},{environment:{TEST_SECRET:"test-secret"},fetch:async url => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.includes("/begin/")) return new Response(null,{status:204,headers:{"arcadedb-session-id":"AS-test"}});
    if (pathname.includes("/commit/")) {commits++; throw new Error("network failure");}
    return new Response(null,{status:204});
  }});
  try {
    const session = connection.driver.session({database:connection.database});
    await assert.rejects(session.executeWrite(async () => "done"),/ARCADEDB_COMMIT_OUTCOME_UNKNOWN/);
    assert.equal(commits,1);
    await session.close();
  } finally { await connection.driver.close(); }
});

test("expired sessions, closed connections and unsafe numbers fail explicitly", async () => {
  const connection = await openArcadeDbConnection({uri:"http://127.0.0.1:2480",username:"reader",database:"synthetic_probe",passwordSource:{kind:"ENVIRONMENT",variable:"TEST_SECRET"}},{environment:{TEST_SECRET:"test-secret"},fetch:async () => new Response(JSON.stringify({result:[]}),{headers:{"arcadedb-session-expired":"AS-old"}})});
  const session = connection.driver.session({database:connection.database});
  await assert.rejects(session.run("RETURN 1"),/ARCADEDB_SESSION_EXPIRED/);
  await assert.rejects(session.run("RETURN $n",{n:Number.MAX_SAFE_INTEGER+1}),/ARCADEDB_UNSAFE_NUMBER/);
  assert.throws(()=>connection.driver.session({database:"different"}),/ARCADEDB_DATABASE_MISMATCH/);
  await connection.driver.close();
  await assert.rejects(session.run("RETURN 1"),/ARCADEDB_SESSION_CLOSED/);
});
