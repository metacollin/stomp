// Markdown to HTML for the docs in the app: the subset stomp's docs use.
//
// Blocks: ATX headings, paragraphs, fenced code, bullet and numbered lists (nested,
// with code and paragraphs inside), tables, block quotes and rules. Inline: code
// spans, links, images, **bold**, *italic* and backslash escapes. No raw HTML: it's
// shown as text. Headings get GitHub's ids, so links written for GitHub work here too.
//
//   render(md, { prefix, link, image }) -> { title, html, toc, snippets }
//     prefix: put before every heading id (one page among several)
//     link(href): { href, external, open } for a link's target
//     image(src, alt): the HTML for an image (an <img> if not given); an image alone
//       in its paragraph stands on its own, as a figure
//     toc: the h2 and h3 headings, { level, id, text }
//     snippets: the stomp code blocks, { code, heading, id, runnable }

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A heading's id, as GitHub makes it from the heading's text. */
export function slugify(text) {
  return plain(text).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
}

/** Inline markdown as plain text: code, link text and emphasis kept, markup dropped. */
export function plain(text) {
  return String(text)
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\s][^*]*)\*/g, '$1')
    .trim();
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`]*)$/;
const LIST = /^(\s*)([-*+]|(\d{1,9})[.)])(\s+|$)(.*)$/;
const indentOf = (line) => /^\s*/.exec(line)[0].replace(/\t/g, '    ').length;
const isTableSep = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-') && line.includes('|');

function listMarker(line) {
  const m = LIST.exec(line);
  if (!m) return null;
  const indent = indentOf(m[1]);
  return { indent, ordered: m[3] != null, start: m[3] != null ? +m[3] : 1, content: indent + m[2].length + Math.min(m[4].length || 1, 4), text: m[5] };
}

/** Does this line start a block of its own, ending a paragraph? */
function startsBlock(line, inPara) {
  if (FENCE.test(line) || /^\s*#{1,6}\s/.test(line) || /^\s*>/.test(line) || /^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) return true;
  const m = listMarker(line);
  if (m && m.text.trim()) return !inPara || !m.ordered || m.start === 1;
  return false;
}

/** Remove up to n columns of leading spaces. */
function dedent(line, n) {
  let i = 0, col = 0;
  while (i < line.length && col < n && (line[i] === ' ' || line[i] === '\t')) { col += line[i] === '\t' ? 4 : 1; i++; }
  return line.slice(i);
}

function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', code = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      code = code === n ? 0 : code || n;
      cur += '`'.repeat(n); i += n - 1;
      continue;
    }
    if (c === '|' && !code) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m = FENCE.exec(line);
    if (m) {
      const ind = indentOf(m[1]), mark = m[2][0], len = m[2].length, info = m[3].trim();
      const close = new RegExp(`^\\s*\\${mark}{${len},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(dedent(lines[i++], ind));
      i++;
      out.push({ t: 'code', lang: (info.split(/\s+/)[0] || '').toLowerCase(), text: body.join('\n') });
      continue;
    }
    m = /^\s*(#{1,6})\s+(.*?)(\s+#+)?\s*$/.exec(line);
    if (m) { out.push({ t: 'h', level: m[1].length, text: m[2] }); i++; continue; }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { out.push({ t: 'hr' }); i++; continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitCells(line);
      const align = splitCells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'c' : /-+:$/.test(c) ? 'r' : ''));
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitCells(lines[i++]));
      out.push({ t: 'table', head, align, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) inner.push(lines[i++].replace(/^\s*> ?/, ''));
      out.push({ t: 'quote', blocks: parseBlocks(inner) });
      continue;
    }
    const lm = listMarker(line);
    if (lm && lm.text.trim()) {
      const [node, next] = parseList(lines, i, lm);
      out.push(node);
      i = next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], true) && !(/^\s*\|/.test(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++].trim());
    out.push({ t: 'p', text: para.join('\n') });
  }
  return out;
}

function parseList(lines, i, first) {
  const items = [];
  let cur = null, loose = false, gap = false;
  while (i < lines.length) {
    const line = lines[i];
    const m = listMarker(line);
    if (m && m.indent === first.indent && m.ordered === first.ordered && m.text.trim()) {
      if (gap && items.length) loose = true;
      cur = { lines: [m.text], content: m.content };
      items.push(cur);
      gap = false;
      i++;
      continue;
    }
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const nm = listMarker(lines[j]);
      const sibling = nm && nm.indent === first.indent && nm.ordered === first.ordered;
      if (indentOf(lines[j]) >= cur.content || sibling) {
        if (!sibling) cur.lines.push('');
        gap = true;
        i++;
        continue;
      }
      break;
    }
    const ind = indentOf(line);
    if (ind >= cur.content) { cur.lines.push(dedent(line, cur.content)); i++; continue; }
    if (m && m.indent > first.indent) { cur.lines.push(dedent(line, m.indent)); i++; continue; }
    // a lazy continuation of the item's last paragraph
    const last = cur.lines[cur.lines.length - 1];
    if (!gap && last && last.trim() && !startsBlock(line, true)) { cur.lines.push(line.trim()); i++; continue; }
    break;
  }
  return [{ t: first.ordered ? 'ol' : 'ul', start: first.start, loose, items: items.map((it) => parseBlocks(it.lines)) }, i];
}

/** Inline markdown to HTML. */
function inline(text, ctx) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\\' && i + 1 < n && /[\\`*_{}[\]()#+\-.!|>~<]/.test(text[i + 1])) { out += esc(text[i + 1]); i += 2; continue; }
    if (c === '`') {
      let k = 1;
      while (text[i + k] === '`') k++;
      const ticks = '`'.repeat(k);
      let j = text.indexOf(ticks, i + k);
      while (j >= 0 && text[j + k] === '`') j = text.indexOf(ticks, j + k + 1);
      if (j >= 0) {
        let code = text.slice(i + k, j).replace(/\n/g, ' ');
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        out += `<code>${esc(code)}</code>`;
        i = j + k;
        continue;
      }
      out += esc(ticks);
      i += k;
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      const j = closeBracket(text, i + 1);
      if (j > 0 && text[j + 1] === '(') {
        const k = text.indexOf(')', j + 2);
        if (k > 0) {
          const alt = plain(text.slice(i + 2, j)), src = text.slice(j + 2, k).trim();
          out += ctx.image ? ctx.image(src, alt) : `<img src="${esc(src)}" alt="${esc(alt)}">`;
          i = k + 1;
          continue;
        }
      }
    }
    if (c === '[') {
      const j = closeBracket(text, i);
      if (j > 0 && text[j + 1] === '(') {
        const k = text.indexOf(')', j + 2);
        if (k > 0) {
          const label = text.slice(i + 1, j), href = text.slice(j + 2, k).trim();
          const L = ctx.link ? ctx.link(href) : { href };
          const attrs = [`href="${esc(L.href)}"`];
          if (L.external) attrs.push('target="_blank"', 'rel="noopener"');
          if (L.open) attrs.push(`data-open="${esc(L.open)}"`);
          out += `<a ${attrs.join(' ')}>${inline(label, ctx)}</a>`;
          i = k + 1;
          continue;
        }
      }
    }
    if (c === '*' && text[i + 1] === '*') {
      const k = text.indexOf('**', i + 2);
      if (k > i + 2) { out += `<strong>${inline(text.slice(i + 2, k), ctx)}</strong>`; i = k + 2; continue; }
    }
    if (c === '*' && text[i + 1] !== '*' && text[i + 1] && !/\s/.test(text[i + 1])) {
      let k = i + 1;
      while (k < n && !(text[k] === '*' && text[k + 1] !== '*' && text[k - 1] !== '*' && !/\s/.test(text[k - 1]))) k++;
      if (k < n) { out += `<em>${inline(text.slice(i + 1, k), ctx)}</em>`; i = k + 1; continue; }
    }
    if (c === '<') {
      const m = /^<(https?:\/\/[^>\s]+)>/.exec(text.slice(i));
      if (m) { out += `<a href="${esc(m[1])}" target="_blank" rel="noopener">${esc(m[1])}</a>`; i += m[0].length; continue; }
    }
    out += esc(c);
    i++;
  }
  return out;
}

/** The `]` that closes the `[` at i, skipping code spans and nested brackets. */
function closeBracket(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') { const k = text.indexOf('`', j + 1); if (k < 0) return -1; j = k; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return j;
  }
  return -1;
}

export function render(md, opts) {
  const o = opts || {};
  const prefix = o.prefix || '';
  const ctx = { link: o.link, image: o.image };
  const blocks = parseBlocks(String(md).replace(/\r\n?/g, '\n').split('\n'));
  const toc = [], snippets = [], seen = new Map();
  let title = null, heading = null, headingId = null;
  const htmlOf = (list, tight) => list.map((b, k) => block(b, tight && k === 0)).join('\n');
  function block(b, bare) {
    switch (b.t) {
      case 'h': {
        const text = plain(b.text);
        let slug = slugify(b.text);
        const dup = seen.get(slug) || 0;
        seen.set(slug, dup + 1);
        if (dup) slug += `-${dup}`;
        const id = prefix + slug;
        if (b.level === 1 && title == null) title = text;
        if (b.level === 2 || b.level === 3) toc.push({ level: b.level, id, text });
        if (b.level > 1) { heading = text; headingId = id; }
        const anchor = b.level > 1 ? `<a class="anchor" href="#${esc(id)}" aria-label="Link to this section">#</a>` : '';
        return `<h${b.level} id="${esc(id)}">${inline(b.text, ctx)}${anchor}</h${b.level}>`;
      }
      case 'p':
        if (/^!\[[^\]]*\]\([^)\s]+\)$/.test(b.text.trim())) return inline(b.text.trim(), ctx);   // a figure
        return bare ? inline(b.text, ctx) : `<p>${inline(b.text, ctx)}</p>`;
      case 'hr': return '<hr>';
      case 'code': {
        const attrs = b.lang ? ` data-lang="${esc(b.lang)}"` : '';
        if (b.lang === 'stomp') {
          const k = snippets.length;
          snippets.push({ code: b.text, heading, id: headingId, runnable: /^\s*footprints?\b/m.test(b.text) && !/…/.test(b.text) });
          return `<div class="code-wrap"><pre class="code"${attrs} data-i="${k}"><code>${esc(b.text)}</code></pre></div>`;
        }
        return `<div class="code-wrap"><pre class="code"${attrs}><code>${esc(b.text)}</code></pre></div>`;
      }
      case 'quote': return `<blockquote>${htmlOf(b.blocks)}</blockquote>`;
      case 'ul': case 'ol': {
        const items = b.items.map((it) => `<li>${htmlOf(it, !b.loose)}</li>`).join('\n');
        return b.t === 'ol' ? `<ol${b.start !== 1 ? ` start="${b.start}"` : ''}>\n${items}\n</ol>` : `<ul>\n${items}\n</ul>`;
      }
      case 'table': {
        const cls = (k) => (b.align[k] ? ` class="al-${b.align[k]}"` : '');
        const head = b.head.map((c, k) => `<th${cls(k)}>${inline(c, ctx)}</th>`).join('');
        const rows = b.rows.map((r) => `<tr>${b.head.map((_, k) => `<td${cls(k)}>${inline(r[k] || '', ctx)}</td>`).join('')}</tr>`).join('\n');
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>`;
      }
      default: return '';
    }
  }
  const html = htmlOf(blocks);
  return { title, html, toc, snippets };
}
