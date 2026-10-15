import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

export const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/^(password|passwd|pwd|token|secret|authorization|api[_-]?key|(?:access|refresh)[_-]?token|cookie|owner|dataSource|sourcePath|raw_json)$/i.test(k)).map(([k, v]) => [k, sanitize(v)]));
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]')
    .replace(/\b(password|passwd|pwd|api[_-]?key|secret|access[_-]?token)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,'";]+)/gi, '$1=[REDACTED]')
    .replace(/\b(?:jdbc:)?(?:https?|mysql|postgresql|oracle|hdfs|bolt):[^\s'"<>]+/gi, '[CONNECTION]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[ADDRESS]')
    .replace(/[A-Za-z]:[\\/][^\s'"<>]+/g, '[LOCAL_PATH]');
}
export function within(base, path) {
  const rel = relative(resolve(base), resolve(path));
  return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
}
export function loadConfig(path) {
  const cfg = readJson(path), home = dirname(resolve(path));
  if (!cfg.provider || !cfg.limits || !Array.isArray(cfg.sources)) throw Error('INVALID_CONFIG');
  cfg.home = home;
  cfg.repositoryRoot = resolve(home, cfg.repositoryRoot);
  cfg.outputDirectory = resolve(home, cfg.outputDirectory);
  if (!within(home, cfg.outputDirectory) || cfg.outputDirectory === home) throw Error('OUTPUT_MUST_BE_INSIDE_WORKFLOW_DIRECTORY');
  for (const key of ['totalTokens', 'maxPackChars', 'fieldsPerAsset', 'tasksPerPack', 'sqlCharsPerTask', 'graphBindingsPerTask', 'documentsPerPack', 'documentChars']) {
    if (!Number.isSafeInteger(cfg.limits[key]) || cfg.limits[key] < 1) throw Error(`INVALID_LIMIT:${key}`);
  }
  if (!Number.isSafeInteger(cfg.provider.maxOutputTokens) || cfg.provider.maxOutputTokens < 64) throw Error('INVALID_OUTPUT_LIMIT');
  if (cfg.limits.pilotMaxPackChars !== undefined && (!Number.isSafeInteger(cfg.limits.pilotMaxPackChars) || cfg.limits.pilotMaxPackChars < 1)) throw Error('INVALID_PILOT_PACK_LIMIT');
  if (Object.keys(cfg.provider.extraBody ?? {}).some(k => !['temperature', 'top_p', 'thinking', 'reasoning_effort'].includes(k))) throw Error('UNSUPPORTED_PROVIDER_EXTRA_BODY');
  mkdirSync(cfg.outputDirectory, { recursive: true });
  return cfg;
}
export async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  // Keep only bounded, scrubbed diagnostic fields; never persist raw responses or headers.
  if (!response.ok) {
    const error = Error(`HTTP_${response.status}`);
    let data;
    try { data = await response.json(); } catch { data = null; }
    const detail = data?.error;
    if (detail && typeof detail === 'object') {
      error.providerDetail = sanitize({ code: detail.code, type: detail.type, param: detail.param, message: String(detail.message ?? '').slice(0, 500) });
      const credential = options.headers?.Authorization?.replace(/^Bearer\s+/i, '');
      if (credential) error.providerDetail.message = error.providerDetail.message.replaceAll(credential, '[REDACTED]');
    }
    throw error;
  }
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 8000000) throw Error('RESPONSE_TOO_LARGE');
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  if (response.headers.get('content-type')?.includes('text/event-stream') || text.trimStart().startsWith('data:')) return parseEvents(text);
  try { return JSON.parse(text); } catch { throw Error('INVALID_RESPONSE_JSON'); }
}

export function parseEvents(text) {
  let content = '', usage = null, finish = null, done = false, reasoningCharacters = 0, model = null;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    if (!data) continue;
    if (data === '[DONE]') { done = true; continue; }
    let value;
    try { value = JSON.parse(data); } catch { throw Error('INVALID_STREAM_JSON'); }
    if (value.error) throw Error('PROVIDER_STREAM_ERROR');
    if (value.usage) usage = value.usage;
    if (typeof value.model === 'string') model = value.model;
    const choice = value.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (typeof choice?.delta?.reasoning_content === 'string') reasoningCharacters += choice.delta.reasoning_content.length;
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  if (!done && !finish) throw Error('INCOMPLETE_STREAM');
  return { choices: [{ finish_reason: finish, message: { content } }], usage, model, diagnostics: { reasoningCharacters, completionCharacters: content.length } };
}
