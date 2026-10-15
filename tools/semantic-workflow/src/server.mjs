import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateResult } from './model.mjs';
import { exportModel } from './runner.mjs';
import { pilotReport, saveItemReview } from './review.mjs';

const webRoot = new URL('../web/', import.meta.url);
export function serve(state, { port = 8795 } = {}) {
  const csrf = randomBytes(24).toString('hex');
  const server = createServer(async (req, res) => {
    const expectedHost = `127.0.0.1:${server.address().port}`;
    const origin = `http://${expectedHost}`;
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== origin)) return json(403, { error: 'LOCAL_ORIGIN_REQUIRED' });
    const url = new URL(req.url, origin);
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, { csrf, usage: state.usage(), items: state.items(), model: exportModel(state) });
      if (req.method === 'GET' && url.pathname === '/api/pilot') return json(200, { csrf, usage: state.usage(), ...pilotReport(state) });
      if (req.method === 'GET' && url.pathname === '/api/pack') {
        const pack = state.pack(url.searchParams.get('hash') ?? '');
        return json(pack ? 200 : 404, pack ?? { error: 'NOT_FOUND' });
      }
      if (req.method === 'POST' && ['/api/review', '/api/pilot/review'].includes(url.pathname)) {
        const supplied = String(req.headers['x-csrf-token'] ?? '');
        if (supplied.length !== csrf.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf))) return json(403, { error: 'CSRF' });
        if (!String(req.headers['content-type']).startsWith('application/json')) return json(415, { error: 'JSON_REQUIRED' });
        let size = 0, chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 1000000) return json(413, { error: 'BODY_TOO_LARGE' }); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.pathname === '/api/pilot/review') {
          try { return json(200, { ok: true, ...saveItemReview(state, body) }); }
          catch (e) { return json(400, { error: e.message }); }
        }
        const attempt = state.attempt(body.attemptId);
        if (!attempt) return json(404, { error: 'ATTEMPT_NOT_FOUND' });
        const pack = state.pack(attempt.pack_hash), errors = validateResult(body.result, pack);
        if (pack.pilot) return json(400, { error: 'PILOT_REQUIRES_ITEM_REVIEW' });
        if (errors.length) return json(400, { errors });
        state.review(body.attemptId, body.status, body.result);
        return json(200, { ok: true });
      }
      const paths = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/pilot', ['pilot.html', 'text/html']], ['/pilot.js', ['pilot.js', 'text/javascript']], ['/pilot.css', ['pilot.css', 'text/css']]]);
      if (req.method === 'GET' && paths.has(url.pathname)) {
        const [file, mime] = paths.get(url.pathname);
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
        return res.end(readFileSync(fileURLToPath(new URL(file, webRoot))));
      }
      json(404, { error: 'NOT_FOUND' });
    } catch { json(400, { error: 'INVALID_REQUEST' }); }
  });
  server.listen(port, '127.0.0.1'); return server;
}
