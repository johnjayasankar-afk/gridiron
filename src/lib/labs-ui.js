/* labs-ui · the behaviour that goes with labs-ui.css
   ----------------------------------------------------------------------------
   One module, framework free. Call init() with the selectors an app wants glass
   and motion on, and it does the rest:

     import { initLabsUI } from './labs-ui.js';
     initLabsUI({
       glass: [{ sel: 'header', spec: 1, lens: [13, 52, 9, 1.95] }],
       reveal: ['section', '.card'],
       headings: 'h1, h2',
       cascade: ['.grid'],
     });

   In a plain page a module script does the same thing, and window.LabsUI is set
   for anything that cannot import.

   Every effect is off when the reader asks for less motion. The lens is Chromium
   only; everywhere else the same surfaces keep frosted glass, which is what the
   stylesheet gives them without help.
*/

const NS = 'http://www.w3.org/2000/svg';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [].slice.call((r || document).querySelectorAll(s));

/* Nothing here may touch window or document while the module is being evaluated:
   a Next.js page renders this file on the server first, where neither exists. The
   answers are worked out on the first init() instead, and they never change after. */
const BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
const mq = (q) => BROWSER && !!(window.matchMedia && window.matchMedia(q).matches);

let REDUCED = false, FINE = false, HAS_IO = false, LENS = false, sensed = false;
/* one canvas answers whether this browser takes WebP, for images fetched later */
export let WEBP = false;

function sense() {
  if (sensed || !BROWSER) return;
  sensed = true;
  REDUCED = mq('(prefers-reduced-motion: reduce)');
  FINE = mq('(pointer: fine)');
  HAS_IO = 'IntersectionObserver' in window;
  const brands = navigator.userAgentData && navigator.userAgentData.brands;
  LENS = !!(brands && brands.some((b) => /Chromium/.test(b.brand))) && !mq('(prefers-reduced-transparency: reduce)');
  try { WEBP = document.createElement('canvas').toDataURL('image/webp').indexOf('data:image/webp') === 0; } catch (e) { WEBP = false; }
}
export function supportsWebP() { sense(); return WEBP; }

let defs = null;
const cache = {};
let seq = 0;

function svgNode(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

/* a rounded rectangle seen as a lens: the rim bends light inward, the middle is flat */
function lensMap(w, h, r, bezel) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
  const cx = w / 2, cy = h / 2, ax = Math.max(0, w / 2 - r), ay = Math.max(0, h / 2 - r);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + .5 - cx, py = y + .5 - cy, qx = Math.abs(px) - ax, qy = Math.abs(py) - ay;
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
      const inside = -(Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r);
      let nx = 0, ny = 0;
      if (qx > 0 && qy > 0) { const l = Math.sqrt(qx * qx + qy * qy) || 1; nx = qx / l * (px < 0 ? -1 : 1); ny = qy / l * (py < 0 ? -1 : 1); }
      else if (qx > qy) nx = px < 0 ? -1 : 1;
      else ny = py < 0 ? -1 : 1;
      /* a spherical bevel: light bends hardest at the very rim, then eases off */
      const t = Math.min(1, Math.max(0, inside / bezel)), u = 1 - t;
      const m = inside <= 0 ? 0 : Math.min(1, .55 * u / Math.sqrt(Math.max(1e-3, 1 - u * u)));
      const i = (y * w + x) * 4;
      d[i] = 128 - nx * m * 127;
      d[i + 1] = 128 - ny * m * 127;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

function filterFor(w, h, r, cfg) {
  const key = [w, h, r, cfg[0], cfg[1], cfg[2], cfg[3]].join('_');
  if (cache[key]) return cache[key];
  if (!defs) {
    const svg = svgNode('svg', { width: 0, height: 0, 'aria-hidden': 'true' }, document.body);
    svg.style.position = 'absolute';
    defs = svgNode('defs', {}, svg);
  }
  /* the map is built at a smaller size and stretched back: the rim is smooth either way */
  const s = Math.min(1, 460 / Math.max(w, h)), mw = Math.max(8, Math.round(w * s)), mh = Math.max(8, Math.round(h * s));
  const id = 'lgl-' + (++seq);
  const f = svgNode('filter', { id, x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' }, defs);
  svgNode('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: cfg[2], result: 'soft' }, f);
  svgNode('feImage', { href: lensMap(mw, mh, r * s, cfg[0] * s), x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'lens' }, f);
  if (w * h > 150000) {
    /* one pass on a large pane: three would cost a frame on every scroll */
    svgNode('feDisplacementMap', { in: 'soft', in2: 'lens', scale: cfg[1], xChannelSelector: 'R', yChannelSelector: 'G', result: 'one' }, f);
    svgNode('feColorMatrix', { in: 'one', type: 'saturate', values: cfg[3] }, f);
    cache[key] = id;
    return id;
  }
  /* three passes, one per channel, so the rim carries a hint of colour like real glass */
  [['r', 1, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'],
   ['g', .91, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'],
   ['b', .82, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0']].forEach((ch) => {
    svgNode('feDisplacementMap', { in: 'soft', in2: 'lens', scale: cfg[1] * ch[1], xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' + ch[0] }, f);
    svgNode('feColorMatrix', { in: 'd' + ch[0], type: 'matrix', values: ch[2], result: ch[0] }, f);
  });
  svgNode('feComposite', { in: 'r', in2: 'g', operator: 'arithmetic', k2: 1, k3: 1, result: 'rg' }, f);
  svgNode('feComposite', { in: 'rg', in2: 'b', operator: 'arithmetic', k2: 1, k3: 1, result: 'rgb' }, f);
  svgNode('feColorMatrix', { in: 'rgb', type: 'saturate', values: cfg[3] }, f);
  cache[key] = id;
  return id;
}

function dressGlass(parts) {
  const panes = [];
  parts.forEach((part) => {
    $$(part.sel).forEach((el) => {
      if (el.dataset.glDone) return;
      el.dataset.glDone = '1';
      el.classList.add(part.flat ? 'gl--flat' : 'gl');
      if (part.dark) el.classList.add('gl--dark');
      if (part.mint) el.classList.add('gl--mint');
      if (part.clear) el.classList.add('gl--clear');
      if (part.spec && !REDUCED) el.classList.add('gl--spec');
      if (part.vars) for (const k in part.vars) el.style.setProperty(k, part.vars[k]);
      panes.push({ el, part });
      if (!LENS || !part.lens) return;
      let timer = 0, last = '';
      const fit = () => {
        /* sizes are rounded so a morphing surface reuses one lens instead of building
           a new one at every step */
        const b = el.getBoundingClientRect(), w = Math.round(b.width / 4) * 4, h = Math.round(b.height / 2) * 2;
        if (w < 24 || h < 16) return;
        const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2);
        const key = w + 'x' + h + 'x' + Math.round(r);
        if (key === last) return;
        last = key;
        /* frosted glass instead: a pane this big cannot carry a lens every frame */
        if (w * h > 420000 && !part.overlay) { el.classList.remove('gl-on'); return; }
        /* a round control is all lens: the dome runs from the rim to the middle */
        const cfg = part.dome ? [Math.min(h, w) / 2, part.lens[1], part.lens[2], part.lens[3]] : part.lens;
        el.style.setProperty('--lg', 'url(#' + filterFor(w, h, r, cfg) + ')');
        el.classList.add('gl-on');
      };
      if ('ResizeObserver' in window) new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(fit, 170); }).observe(el);
      fit();
      /* off screen, the lens is switched off: no backdrop work for glass nobody sees */
      if (HAS_IO && !part.overlay) {
        new IntersectionObserver((en) => {
          if (!el.style.getPropertyValue('--lg')) return;
          el.classList.toggle('gl-on', en[0].isIntersecting);
        }, { rootMargin: '120px' }).observe(el);
      }
    });
  });
  return panes;
}

/* the highlight follows the pointer across the glass */
let sheenOn = false;
function sheen() {
  if (sheenOn || !FINE || REDUCED) return;
  sheenOn = true;
  let raf = 0, mx = 0, my = 0, lit = null;
  document.addEventListener('pointermove', (e) => {
    mx = e.clientX;
    my = e.clientY;
    lit = e.target && e.target.closest ? e.target.closest('.gl--spec') : null;
    if (!lit || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!lit) return;
      const b = lit.getBoundingClientRect();
      lit.style.setProperty('--gx', (mx - b.left).toFixed(0) + 'px');
      lit.style.setProperty('--gy', (my - b.top).toFixed(0) + 'px');
    });
  }, { passive: true });
}

/* ---- headings arrive one word after another --------------------------------------- */
function glued(n) {
  return n.classList && (n.classList.contains('to') || n.classList.contains('sr-only') || n.classList.contains('labs-glue'))
    || n.tagName === 'I' || n.tagName === 'SVG' || n.tagName === 'svg';
}

function splitWords(el) {
  let i = 0;
  (function walk(node) {
    const kids = [].slice.call(node.childNodes), frag = document.createDocumentFragment();
    let cur = null;
    const word = () => {
      if (!cur) {
        cur = document.createElement('span');
        cur.className = 'wd';
        cur.style.setProperty('--wd', Math.min(i++, 14));
        frag.appendChild(cur);
      }
      return cur;
    };
    kids.forEach((n) => {
      if (n.nodeType === 3) {
        /* split on spaces but never on a no-break space, which is there to hold a pair together */
        n.textContent.split(/([^\S ]+)/).forEach((p) => {
          if (!p) return;
          if (/^[^\S ]+$/.test(p)) { cur = null; frag.appendChild(document.createTextNode(p)); return; }
          word().appendChild(document.createTextNode(p));
        });
      } else if (n.nodeType === 1 && glued(n)) {
        word().appendChild(n);
      } else if (n.nodeType === 1 && n.tagName !== 'BR') {
        walk(n); frag.appendChild(n); cur = null;
      } else { frag.appendChild(n); cur = null; }
    });
    /* the text nodes were copied into words, so clear what is left before putting them back */
    while (node.firstChild) node.removeChild(node.firstChild);
    node.appendChild(frag);
  })(el);
}

function heads(sel) {
  if (REDUCED || !sel) return;
  const vh = window.innerHeight || 800;
  $$(sel).forEach((h) => {
    if (h.querySelector('.wd') || h.dataset.wdDone) return;
    const n = (h.textContent || '').trim().split(/\s+/).length;
    if (n < 2 || n > 26) return;
    h.dataset.wdDone = '1';
    splitWords(h);
    const r = h.getBoundingClientRect();
    if (r.top < vh && r.bottom > 0) { h.classList.add('wds--load'); return; }
    h.classList.add('wds');
    /* inside a block labs-ui reveals, the block's own arrival starts the words.
       Anywhere else the heading watches for itself, so it works over any app. */
    if (h.closest('[data-labs-reveal]') || !HAS_IO) { h.classList.add('is-in'); return; }
    h.classList.add('wds--io');
    const io = new IntersectionObserver((en) => {
      if (!en[0].isIntersecting) return;
      io.disconnect();
      h.classList.add('is-in');
    }, { rootMargin: '0px 0px -8% 0px' });
    io.observe(h);
  });
}

/* ---- blocks rise into place ------------------------------------------------------- */
function reveal(selectors, cascadeSel) {
  if (selectors) {
    selectors.forEach((s) => $$(s).forEach((el) => { if (!el.hasAttribute('data-labs-reveal')) el.setAttribute('data-labs-reveal', ''); }));
  }
  /* a grid arrives one card after another, left to right */
  (cascadeSel || []).forEach((s) => $$(s).forEach((grid) => {
    $$('[data-labs-reveal]', grid).forEach((el, i) => { if (!el.style.getPropertyValue('--rd')) el.style.setProperty('--rd', Math.min(i, 5)); });
  }));

  const els = $$('[data-labs-reveal]');
  if (!els.length) return;
  const settle = (el) => el.classList.add('is-in');
  if (REDUCED || !HAS_IO) { els.forEach(settle); return; }
  const vh = window.innerHeight || 800;
  /* whatever is already on screen stays put: no flash, no late motion */
  els.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < vh * .94 && r.bottom > 0) settle(el);
  });
  const release = (el) => {
    const d = parseFloat(getComputedStyle(el).getPropertyValue('--rd')) || 0;
    setTimeout(() => el.classList.add('is-done'), 1300 + d * 70);
  };
  els.forEach((el) => { if (el.classList.contains('is-in')) el.classList.add('is-done'); });
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      io.unobserve(en.target);
      settle(en.target);
      release(en.target);
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0 });
  els.forEach((el) => { if (!el.classList.contains('is-in')) io.observe(el); });
}

/* ---- depth: a layer that drifts slower than the page ------------------------------ */
function parallax(cfg) {
  if (REDUCED || !cfg) return;
  const el = typeof cfg.el === 'string' ? $(cfg.el) : cfg.el;
  if (!el) return;
  const far = cfg.far == null ? 34 : cfg.far, near = cfg.near == null ? -16 : cfg.near, span = cfg.span || 900;
  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const p = Math.min(1, (window.scrollY || 0) / span);
      el.style.setProperty('--pz', (p * far).toFixed(1) + 'px');
      el.style.setProperty('--pz2', (p * near).toFixed(1) + 'px');
    });
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ---- a floating bar that knows when it is over something dark --------------------- */
function tone(barSel, darkSel) {
  if (!barSel || !darkSel) return;
  const bar = typeof barSel === 'string' ? $(barSel) : barSel;
  const darks = $$(darkSel);
  if (!bar || !darks.length) return;
  let raf = 0;
  const check = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const b = bar.getBoundingClientRect(), mid = b.top + b.height / 2;
      const over = darks.some((d) => { const r = d.getBoundingClientRect(); return r.top < mid && r.bottom > mid; });
      bar.classList.toggle('gl--dark', over);
      bar.classList.toggle('is-over-dark', over);
    });
  };
  addEventListener('scroll', check, { passive: true });
  addEventListener('resize', check);
  check();
}

/* ---- the one entry point ---------------------------------------------------------- */
export function initLabsUI(config) {
  const cfg = config || {};
  if (!BROWSER) return { refresh() {} };
  let watcher = null;
  const run = () => {
    try {
      sense();
      /* the class only turns the transitions on; the offset state is scoped to the
         elements labs-ui itself marks, so an app's own reveal is untouched */
      if (!REDUCED) document.documentElement.classList.add('labs-reveal');
      if (cfg.glass && cfg.glass.length) { dressGlass(cfg.glass); sheen(); }
      reveal(cfg.reveal, cfg.cascade);
      heads(cfg.headings);
      parallax(cfg.parallax);
      tone(cfg.toneBar, cfg.toneDark);
      document.documentElement.classList.add('labs-ui-on');
    } catch (e) {
      /* a decorative layer must never take the app down with it */
      if (window.console && console.warn) console.warn('labs-ui:', e);
    }
  };
  /* An app that renders its own DOM replaces the nodes labs-ui dressed. Watching
     for new ones and dressing those is cheaper, and far less brittle, than asking
     every view to remember to call refresh(). */
  const watch = () => {
    if (watcher || !cfg.observe || !('MutationObserver' in window)) return;
    let queued = 0;
    watcher = new MutationObserver((records) => {
      if (queued) return;
      const added = records.some((r) => r.addedNodes && r.addedNodes.length);
      if (!added) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        try {
          if (cfg.glass && cfg.glass.length) dressGlass(cfg.glass);
          heads(cfg.headings);
          reveal(cfg.reveal, cfg.cascade);
        } catch (e) { /* the app keeps running either way */ }
      });
    });
    watcher.observe(document.body, { childList: true, subtree: true });
  };
  const start = () => { run(); watch(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  return {
    refresh: run,
    stop() { if (watcher) { watcher.disconnect(); watcher = null; } },
  };
}

/* anything that cannot import still gets a handle */
if (BROWSER) window.LabsUI = { init: initLabsUI, supportsWebP };

export default initLabsUI;
