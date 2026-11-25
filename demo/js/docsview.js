/* stomp: the documentation, shown in place of the editor.
 *
 * The pages come from docs.js, made by tools/build.mjs from the Markdown files in the
 * repository, so they read the same here and on GitHub. Each page and each heading
 * has its own #link: `#tutorial`, `#reference-pads-and-holes`. stomp code blocks are
 * highlighted as in the editor, and Try it on a block that makes a footprint turns it
 * into an editor with the footprint drawn beside it (playground.js), right there.
 */
(function (root) {
  'use strict';
  const S = root.Stomp = root.Stomp || {};
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** A #route as { page, anchor }, or null when it names no page. */
  function parseRoute(hash, pages) {
    let h = String(hash || '').replace(/^#/, '');
    try { h = decodeURIComponent(h); } catch (e) { /* keep it as written */ }
    const i = h.indexOf('-');
    const page = i < 0 ? h : h.slice(0, i);
    if (!pages.some((p) => p.key === page)) return null;
    return { page, anchor: i < 0 ? null : h.slice(i + 1) };
  }

  function createDocs(host, opts) {
    const o = opts || {};
    const pages = (S.docs && S.docs.pages) || [];
    const nav = host.querySelector('.docs-nav');
    const body = host.querySelector('.docs-body');
    let current = null, spy = null;
    const scrolls = new Map();       // page key to where it was left
    let pg = null;                   // the open playground: { wrap, host, play }

    function closePlayground(refocus) {
      if (!pg) return;
      const { wrap, host, play } = pg;
      pg = null;
      play.destroy();
      host.remove();
      wrap.hidden = false;
      if (refocus) { const b = wrap.querySelector('[data-try]'); if (b) b.focus(); }
    }
    function openPlayground(page, k, wrap) {
      closePlayground();
      const P = o.playground;
      const snip = page.snippets[k];
      const file = `doc:${page.key}:${k}`;
      const draft = P.draft(file);
      const host = document.createElement('div');
      wrap.after(host);
      wrap.hidden = true;
      const play = S.createPlayground(host, {
        code: draft != null ? draft : snip.code,
        original: snip.code,
        compile: P.compile, model: P.model, units: P.units, dark: P.dark,
        onChange: (text) => P.save(file, text === snip.code ? null : text),
        onOpen: () => { closePlayground(); P.open(page, k); },
        onClose: () => closePlayground(true),
      });
      pg = { wrap, host, play };
      host.scrollIntoView({ block: 'nearest' });
      play.focus();
    }

    // the scrolling box: the article on wide screens, the window on narrow ones
    const scroller = () => (body.scrollHeight > body.clientHeight + 1 && getComputedStyle(body).overflowY !== 'visible' ? body : document.scrollingElement || document.documentElement);

    function renderNav() {
      const page = pages.find((p) => p.key === current);
      let html = '<button type="button" class="btn ghost docs-back" data-back>Back to the editor</button><ol class="docs-pages">';
      for (const p of pages) {
        const on = p.key === current;
        html += `<li${on ? ' class="on"' : ''}><a href="#${p.key}"${on ? ' aria-current="page"' : ''}>${esc(p.nav)}</a>`;
        if (on && page.toc.length) {
          html += '<ol class="docs-toc">';
          for (const t of page.toc) html += `<li class="l${t.level}"><a href="#${esc(t.id)}" data-id="${esc(t.id)}">${esc(t.text)}</a></li>`;
          html += '</ol>';
        }
        html += '</li>';
      }
      nav.innerHTML = html + '</ol>';
    }

    function renderPage(page) {
      closePlayground();
      body.innerHTML = `<div class="docs-page" data-page="${esc(page.key)}">${page.html}</div>`;
      body.querySelectorAll('pre.code').forEach((pre) => {
        const code = pre.querySelector('code');
        const k = pre.dataset.i;
        if (pre.dataset.lang === 'stomp' && S.highlight) code.innerHTML = S.highlight(code.textContent);
        const tools = document.createElement('div');
        tools.className = 'code-tools';
        const snip = k != null ? page.snippets[+k] : null;
        if (snip && snip.runnable && o.playground) tools.innerHTML += `<button type="button" class="chip try" data-try="${k}" title="Edit this code here, with its footprint drawn beside it">Try it</button>`;
        tools.innerHTML += '<button type="button" class="chip" data-copy title="Copy this code">Copy</button>';
        pre.parentNode.insertBefore(tools, pre);
      });
      watchHeadings();
    }

    // the table of contents follows the section on screen
    function watchHeadings() {
      if (spy) { spy.disconnect(); spy = null; }
      if (!('IntersectionObserver' in root)) return;
      const heads = [...body.querySelectorAll('h2[id], h3[id]')];
      if (!heads.length) return;
      const seen = new Map();
      spy = new IntersectionObserver((entries) => {
        for (const en of entries) seen.set(en.target.id, en.isIntersecting ? en.boundingClientRect.top : null);
        const firstVisible = heads.find((h) => seen.get(h.id) != null);
        let id = firstVisible ? firstVisible.id : null;
        if (!id) {
          // between headings: the last one above the view
          const above = heads.filter((h) => h.getBoundingClientRect().top < 80);
          id = above.length ? above[above.length - 1].id : heads[0].id;
        }
        nav.querySelectorAll('.docs-toc a').forEach((a) => a.classList.toggle('here', a.dataset.id === id));
      }, { root: scroller() === body ? body : null, rootMargin: '0px 0px -70% 0px' });
      heads.forEach((h) => spy.observe(h));
    }

    host.addEventListener('click', (e) => {
      const t = e.target.closest('[data-back], [data-try], [data-copy], a[data-open]');
      if (!t) return;
      if (t.hasAttribute('data-back')) { if (o.onBack) o.onBack(); return; }
      if (t.hasAttribute('data-open')) { e.preventDefault(); if (o.onOpen) o.onOpen(t.dataset.open); return; }
      const page = pages.find((p) => p.key === current);
      if (t.hasAttribute('data-try')) {
        openPlayground(page, +t.dataset.try, t.closest('.code-wrap'));
        return;
      }
      if (t.hasAttribute('data-copy')) {
        const code = t.parentNode.nextElementSibling.textContent;
        const done = (ok) => { t.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { t.textContent = 'Copy'; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(() => done(true), () => done(false));
        else done(false);
      }
    });

    return {
      pages,
      parse: (hash) => parseRoute(hash, pages),
      /** Show a page, at a heading (an id without the page's prefix), or where it was left. */
      show(key, anchor, resume) {
        const page = pages.find((p) => p.key === key) || pages[0];
        if (!page) return;
        if (current && current !== page.key) scrolls.set(current, scroller().scrollTop);
        const fresh = current !== page.key || !body.firstChild;
        current = page.key;
        host.hidden = false;           // first, so the page is measured in its own box
        if (fresh) { renderPage(page); renderNav(); }
        const target = anchor ? document.getElementById(`${page.key}-${anchor}`) : null;
        if (target) target.scrollIntoView({ block: 'start' });
        else if (resume && scrolls.has(page.key)) scroller().scrollTop = scrolls.get(page.key);
        else if (fresh) scroller().scrollTop = 0;
        if (target) {
          target.classList.add('flash');
          setTimeout(() => target.classList.remove('flash'), 1400);
        }
      },
      hide() {
        closePlayground();
        if (current && !host.hidden) scrolls.set(current, scroller().scrollTop);
        host.hidden = true;
      },
      /** Scroll to a code block, as when coming back from trying it. */
      showSnippet(key, k) {
        this.show(key, null, true);
        const pre = body.querySelector(`pre.code[data-i="${k}"]`);
        if (pre) { pre.parentNode.scrollIntoView({ block: 'center' }); pre.parentNode.classList.add('flash'); setTimeout(() => pre.parentNode.classList.remove('flash'), 1400); }
      },
      current: () => current,
      shown: () => !host.hidden,
    };
  }

  S.createDocs = createDocs;
  S.parseDocsRoute = parseRoute;
})(typeof self !== 'undefined' ? self : this);
