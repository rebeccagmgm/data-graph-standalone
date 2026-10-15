import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { openMap, defaultOutput } from "./query.mjs";
import { dispatch } from "./cli.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export function createMapServer({ outputRoot = defaultOutput } = {}) {
  const ctx = openMap(outputRoot);
  const files = new Map([
    ["/", ["analysis.html", "text/html; charset=utf-8"]],
    ["/analysis.html", ["analysis.html", "text/html; charset=utf-8"]],
    ["/analysis.js", ["analysis.js", "text/javascript; charset=utf-8"]],
    ["/analysis.css", ["analysis.css", "text/css; charset=utf-8"]],
    ["/inventory", ["index.html", "text/html; charset=utf-8"]],
    ["/view.js", ["view.js", "text/javascript; charset=utf-8"]],
    ["/view.css", ["view.css", "text/css; charset=utf-8"]],
  ]);
  const server = createServer(async (req, res) => {
    const host = req.headers.host || "";
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }
    try {
      const url = new URL(req.url, `http://${host}`);
      if (files.has(url.pathname)) {
        const [file, type] = files.get(url.pathname);
        res.writeHead(200, { "Content-Type": type });
        res.end(readFileSync(resolve(here, file)));
        return;
      }
      if (url.pathname === "/baseline") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(readFileSync(resolve(here, "../../docs/processing-map.html")));
        return;
      }
      const match = url.pathname.match(
        /^\/api\/(summary|overview|regions|tasks|task|flows|neighbors|sql|knowledge|analysis-search|analysis-view|analysis-fields|analysis-sql)$/,
      );
      if (!match) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      if (url.search.length > 16000) {
        res.writeHead(400);
        res.end("Query too long");
        return;
      }
      const params = Object.fromEntries(url.searchParams);
      const start = performance.now();
      const data = await dispatch(ctx, match[1], params);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          version: ctx.summary.version,
          data,
          elapsedMs: Math.round(performance.now() - start),
        }),
      );
    } catch (error) {
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "INVALID_ARGUMENT"
            ? 400
            : 500;
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: error.code || "QUERY_ERROR",
            message: error.code ? error.message : "查询失败，请检查地图快照",
          },
        }),
      );
    }
  });
  server.on("close", () => ctx.close());
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let port = 8768,
    outputRoot = defaultOutput;
  const args = process.argv.slice(2);
  while (args.length) {
    const key = args.shift(),
      value = args.shift();
    if (key === "--port" && /^\d+$/.test(value)) port = Number(value);
    else if (key === "--output" && value) outputRoot = resolve(value);
    else throw new Error("使用 --port <端口> 或 --output <产物目录>");
  }
  if (port < 1024 || port > 65535) throw new Error("端口必须在 1024–65535");
  const server = createMapServer({ outputRoot });
  server.on("error", (e) => {
    console.error(
      e.code === "EADDRINUSE" ? `端口 ${port} 已被占用` : "本地服务启动失败",
    );
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      JSON.stringify({
        ready: true,
        url: `http://127.0.0.1:${port}/`,
        pid: process.pid,
      }),
    ),
  );
}
