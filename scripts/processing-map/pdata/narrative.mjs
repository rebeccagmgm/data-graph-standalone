// Build-time rendering for the small authored Markdown subset used by task explanations.
// All text is escaped; no raw HTML, remote resources or executable links are accepted.
const escape = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const inline = (s) =>
  s
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
    .map((part) =>
      part.startsWith("`")
        ? `<code>${escape(part.slice(1, -1))}</code>`
        : part.startsWith("**")
          ? `<strong>${escape(part.slice(2, -2))}</strong>`
          : escape(part),
    )
    .join("");
export function renderProse(markdown) {
  const lines = markdown.trim().split(/\r?\n/),
    output = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    if (lines[i].startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```"))
        code.push(lines[i++]);
      if (i === lines.length) throw new Error("NARRATIVE_UNCLOSED_CODE");
      i++;
      output.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (lines[i].startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|"))
        rows.push(
          lines[i++]
            .split("|")
            .slice(1, -1)
            .map((x) => x.trim()),
        );
      if (!rows[1]?.every((s) => /^:?-+:?$/.test(s)))
        throw new Error("NARRATIVE_INVALID_TABLE");
      output.push(
        `<div class="table-wrap"><table><thead><tr>${rows[0].map((s) => `<th>${inline(s)}</th>`).join("")}</tr></thead><tbody>${rows
          .slice(2)
          .map(
            (row) =>
              `<tr>${row.map((s) => `<td>${inline(s)}</td>`).join("")}</tr>`,
          )
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(\||```)/.test(lines[i]))
      paragraph.push(lines[i++]);
    output.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }
  return output.join("\n");
}
export function compileNarrative(markdown, record) {
  const blocks = markdown.split(/^## /m);
  const sections = blocks.slice(1).map((block) => {
    const newline = block.indexOf("\n"),
      title = block.slice(0, newline).trim();
    const stage = record.stages.find((s) => s.title === title);
    if (!stage)
      throw new Error(`NARRATIVE_STAGE_MISSING: ${record.taskId}:${title}`);
    return { id: stage.id, title, html: renderProse(block.slice(newline + 1)) };
  });
  if (
    sections.length !== record.stages.length ||
    new Set(sections.map((s) => s.id)).size !== record.stages.length
  )
    throw new Error(`NARRATIVE_STAGE_COVERAGE: ${record.taskId}`);
  return { intro: renderProse(blocks[0]), sections };
}
