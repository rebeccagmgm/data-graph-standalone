// A bounded renderer for the authored reading notes, not a general Markdown engine.
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderReading(markdown, links = {}) {
  const inline = (text) => {
    const tokens = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)/g;
    let result = '', start = 0;
    for (const match of text.matchAll(tokens)) {
      result += escapeHtml(text.slice(start, match.index));
      const token = match[0];
      if (token.startsWith('`')) result += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
      else if (token.startsWith('**')) result += `<strong>${inline(token.slice(2, -2))}</strong>`;
      else {
        const [, label, target] = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const [file, anchor = ''] = target.split('#');
        const key = links[file];
        if (!key) throw new Error(`Unmapped reading link: ${file}`);
        result += `<button class="reading-link" data-reading="${escapeHtml(key)}" data-anchor="${escapeHtml(anchor)}">${escapeHtml(label)}</button>`;
      }
      start = match.index + token.length;
    }
    return result + escapeHtml(text.slice(start));
  };
  const lines = markdown.replace(/\r/g, '').split('\n');
  let html = '', section = false, sectionIndex = 0;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const anchor = line.match(/^<a id="([\w-]+)"><\/a>$/);
    if (anchor) {
      if (section) { html += '</details>'; section = false; }
      html += `<span id="reading-${anchor[1]}" class="reading-anchor"></span>`;
      i++; continue;
    }
    if (line.startsWith('## ')) {
      if (section) html += '</details>';
      html += `<details class="reading-section" data-section="${sectionIndex}"${sectionIndex++ === 0 ? ' open' : ''}><summary>${inline(line.slice(3))}</summary>`;
      section = true; i++; continue;
    }
    if (line.startsWith('# ')) { html += `<h2>${inline(line.slice(2))}</h2>`; i++; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim(); const code = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      if (language === 'mermaid') {
        // Show the source-authored routes as readable edges; no remote diagram runtime.
        const labels = new Map(); const routes = [];
        const definition = /\b([A-Za-z]\w*)\[([^\]]+)\]/g;
        for (const row of code) for (const m of row.matchAll(definition)) labels.set(m[1], m[2].replace(/<br\s*\/?\s*>/gi, ' · '));
        for (const row of code) {
          const normalized = row.replace(definition, '$1').trim();
          const edge = normalized.match(/^(\w+)\s+(-->|-\.([^.]*)\.->)\s+(\w+)$/);
          if (edge) routes.push(`<li>${escapeHtml(labels.get(edge[1]) ?? edge[1])}<span class="route-arrow"> → ${escapeHtml(edge[3] || '')} </span>${escapeHtml(labels.get(edge[4]) ?? edge[4])}</li>`);
        }
        html += `<ul class="reading-routes">${routes.join('')}</ul>`;
      } else html += `<pre class="sql">${escapeHtml(code.join('\n'))}</pre>`;
      continue;
    }
    if (line.startsWith('|') && /^\|[\s:|\-]+\|$/.test(lines[i + 1] ?? '')) {
      const cells = (row) => row.trim().slice(1, -1).split('|').map((cell) => inline(cell.trim()));
      const headers = cells(line); i += 2;
      html += `<div class="reading-table"><table><thead><tr>${headers.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
      while (i < lines.length && lines[i].startsWith('|')) html += `<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join('')}</tr>`;
      html += '</tbody></table></div>'; continue;
    }
    if (line.startsWith('- ')) {
      html += '<ul>'; while (i < lines.length && lines[i].startsWith('- ')) html += `<li>${inline(lines[i++].slice(2))}</li>`;
      html += '</ul>'; continue;
    }
    html += `<p>${inline(line)}</p>`; i++;
  }
  return html + (section ? '</details>' : '');
}
