export function redact(value) {
  return String(value ?? "")
    .replace(
      /(?:https?:\/\/|jdbc:|hdfs:\/\/)[^\s"'<>`，）)]+/gi,
      "[环境地址已省略]",
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[环境地址已省略]")
    .replace(/\b[\w.-]+\.gf\.com\.cn\b/gi, "[环境地址已省略]")
    .replace(/[A-Z]:[\\/][^\r\n"'<>`)]+/gi, "[本地证据文件]")
    .replace(
      /((?:password|passwd|secret|token|access[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
      "$1[已省略]",
    );
}
