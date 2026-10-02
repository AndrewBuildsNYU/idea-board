// Turns the board into files people can keep: a PNG of exactly what is on
// screen, and a PDF of every idea and comment.
//
// A page can't screenshot itself, so the picture is drawn onto a canvas from
// the live page. Positions and sizes come from the rendered elements, and
// colours and fonts from their computed styles, so the image matches the
// screen in every theme without keeping a second copy of the design here.
// It leaves out the controls floating over the board (tool bar, hints,
// menus): the picture is of the board.

const ELLIPSIS = '…';

function px(value) {
  return parseFloat(value) || 0;
}

// Splits "a(1, 2), b" at top-level commas only.
function splitTop(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

function fontOf(cs) {
  return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
}

function lineHeightOf(cs) {
  return px(cs.lineHeight) || px(cs.fontSize) * 1.2;
}

function parseShadows(value) {
  if (!value || value === 'none') return [];
  return splitTop(value).map((shadow) => {
    const color = (shadow.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i) || ['rgba(0, 0, 0, 0.3)'])[0];
    const [x = 0, y = 0, blur = 0, spread = 0] = shadow.replace(color, '').trim().split(/\s+/).map(px);
    return { color, x, y, blur, spread, inset: /inset/.test(shadow) };
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
    return;
  }
  ctx.rect(x, y, w, h);
}

// Canvas shadows ignore the transform, so they're scaled by hand.
function setShadow(ctx, shadow, scale) {
  ctx.shadowColor = shadow ? shadow.color : 'transparent';
  ctx.shadowBlur = shadow ? shadow.blur * scale : 0;
  ctx.shadowOffsetX = shadow ? shadow.x * scale : 0;
  ctx.shadowOffsetY = shadow ? shadow.y * scale : 0;
}

// Line-breaks like the page does: at spaces, and anywhere inside a word too
// long for the line (overflow-wrap: anywhere).
function wrap(ctx, text, width) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const token of paragraph.split(/(\s+)/)) {
      if (!token) continue;
      const candidate = line + token;
      if (ctx.measureText(candidate).width <= width || !line.trim()) {
        line = candidate;
      } else {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(token) ? '' : token;
      }
      while (ctx.measureText(line).width > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// Draws an element's text inside its own box, positioned at (x, y), with the
// element's font, colour and line height. `clamp` cuts it to the number of
// lines the page is showing and ends it with an ellipsis, like line-clamp.
function drawText(ctx, el, x, y, text, { clamp = false, ellipsisFit = false } = {}) {
  const cs = getComputedStyle(el);
  ctx.font = fontOf(cs);
  ctx.fillStyle = cs.color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const lineHeight = lineHeightOf(cs);
  const width = el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
  let lines = ellipsisFit ? [text] : wrap(ctx, text, width + 0.5);
  const limit = clamp ? Math.max(1, Math.round((el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom)) / lineHeight)) : Infinity;
  if (lines.length > limit || ellipsisFit) {
    lines = lines.slice(0, limit);
    const i = lines.length - 1;
    if (ctx.measureText(lines[i]).width > width || lines.length < wrap(ctx, text, width + 0.5).length) {
      let last = lines[i];
      while (last && ctx.measureText(last + ELLIPSIS).width > width) last = last.slice(0, -1);
      lines[i] = last.trimEnd() + ELLIPSIS;
    }
  }
  const metrics = ctx.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent ?? px(cs.fontSize) * 0.8;
  const descent = metrics.fontBoundingBoxDescent ?? px(cs.fontSize) * 0.2;
  const top = y + px(cs.paddingTop);
  const left = x + px(cs.paddingLeft);
  lines.forEach((line, i) => {
    ctx.fillText(line, left, top + i * lineHeight + (lineHeight - (ascent + descent)) / 2 + ascent);
  });
}

function drawBoardSurface(ctx, world, width, height, scale) {
  const cs = getComputedStyle(world);
  const radius = px(cs.borderTopLeftRadius);
  // The frame and its drop shadow are box-shadows on the board; the last one
  // listed is painted lowest.
  for (const shadow of parseShadows(cs.boxShadow).reverse()) {
    const grow = shadow.spread;
    ctx.save();
    if (shadow.blur) setShadow(ctx, shadow, scale);
    ctx.fillStyle = shadow.color;
    roundRect(ctx, -grow + (shadow.blur ? 0 : shadow.x), -grow + (shadow.blur ? 0 : shadow.y), width + grow * 2, height + grow * 2, radius + grow);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundRect(ctx, 0, 0, width, height, radius);
  ctx.clip();
  ctx.fillStyle = cs.backgroundColor;
  ctx.fillRect(0, 0, width, height);
  // The texture is a stack of radial-gradient dots; each becomes a repeating
  // tile drawn at 4x and scaled down, so it stays crisp when zoomed in.
  const images = splitTop(cs.backgroundImage === 'none' ? '' : cs.backgroundImage);
  const sizes = splitTop(cs.backgroundSize);
  const positions = splitTop(cs.backgroundPosition);
  const S = 4;
  images.forEach((image, i) => {
    const stops = [...image.matchAll(/(rgba?\([^)]*\)|transparent|#[0-9a-f]{3,8})\s+([\d.]+)px/gi)];
    if (!/^radial-gradient/.test(image) || stops.length < 2) return;
    const [tileW, tileH = tileW] = (sizes[i] || sizes[0] || '8px').split(/\s+/).map(px);
    const [offX = 0, offY = 0] = (positions[i] || '0 0').split(/\s+/).map(px);
    const tile = document.createElement('canvas');
    tile.width = Math.max(1, Math.round(tileW * S));
    tile.height = Math.max(1, Math.round(tileH * S));
    const t = tile.getContext('2d');
    const cx = tile.width / 2;
    const cy = tile.height / 2;
    const inner = px(stops[0][2]) * S;
    const outer = px(stops[1][2]) * S;
    const gradient = t.createRadialGradient(cx, cy, 0, cx, cy, outer);
    gradient.addColorStop(0, stops[0][1]);
    gradient.addColorStop(Math.min(1, inner / outer), stops[0][1]);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    t.fillStyle = gradient;
    t.fillRect(0, 0, tile.width, tile.height);
    const pattern = ctx.createPattern(tile, 'repeat');
    pattern.setTransform(new DOMMatrix().translate(offX, offY).scale(1 / S));
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
  });
  ctx.restore();
}

function drawGroups(ctx, layer, scale) {
  for (const group of layer.children) {
    const cs = getComputedStyle(group);
    const x = group.offsetLeft;
    const y = group.offsetTop;
    const w = group.offsetWidth;
    const h = group.offsetHeight;
    const color = cs.borderTopColor;
    const radius = px(cs.borderTopLeftRadius);
    const border = px(cs.borderTopWidth);
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = color;
    roundRect(ctx, x, y, w, h, radius);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = border;
    ctx.setLineDash([border * 3, border * 2.5]);
    roundRect(ctx, x + border / 2, y + border / 2, w - border, h - border, radius - border / 2);
    ctx.stroke();
    ctx.restore();

    const tag = group.querySelector('.group-tag');
    if (!tag) continue;
    const ts = getComputedStyle(tag);
    const tx = x + border + tag.offsetLeft;
    const ty = y + border + tag.offsetTop;
    ctx.save();
    setShadow(ctx, parseShadows(ts.boxShadow).pop(), scale);
    ctx.fillStyle = ts.backgroundColor;
    roundRect(ctx, tx, ty, tag.offsetWidth, tag.offsetHeight, tag.offsetHeight / 2);
    ctx.fill();
    ctx.restore();
    drawText(ctx, tag, tx, ty, tag.textContent, { ellipsisFit: true });
  }
}

function drawPaths(ctx, paths, scale, withShadow) {
  for (const path of paths) {
    const cs = getComputedStyle(path);
    ctx.save();
    if (withShadow) {
      const shadow = (cs.filter.match(/drop-shadow\((rgba?\([^)]*\))\s+([-\d.]+)px\s+([-\d.]+)px\s+([\d.]+)px\)/) || []);
      if (shadow.length) setShadow(ctx, { color: shadow[1], x: px(shadow[2]), y: px(shadow[3]), blur: px(shadow[4]) * 2 }, scale);
    }
    ctx.strokeStyle = cs.stroke;
    ctx.lineWidth = px(cs.strokeWidth) || px(path.getAttribute('stroke-width')) || 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(path.getAttribute('d')));
    ctx.restore();
  }
}

function drawTexts(ctx, layer) {
  for (const el of layer.children) drawText(ctx, el, el.offsetLeft, el.offsetTop, el.textContent);
}

function drawNotes(ctx, layer, scale) {
  for (const note of layer.children) {
    const cs = getComputedStyle(note);
    const w = note.offsetWidth;
    const h = note.offsetHeight;
    const tilt = (px(note.style.getPropertyValue('--tilt')) * Math.PI) / 180;
    ctx.save();
    ctx.translate(note.offsetLeft + w / 2, note.offsetTop + h / 2);
    ctx.rotate(tilt);
    ctx.translate(-w / 2, -h / 2);
    ctx.save();
    setShadow(ctx, parseShadows(cs.boxShadow).pop(), scale);
    ctx.fillStyle = cs.backgroundColor;
    roundRect(ctx, 0, 0, w, h, px(cs.borderTopLeftRadius));
    ctx.fill();
    ctx.restore();

    for (const part of note.children) {
      if (part.classList.contains('pin')) {
        const ps = getComputedStyle(part);
        const r = part.offsetWidth / 2;
        const cx = part.offsetLeft + r;
        const cy = part.offsetTop + r;
        ctx.save();
        setShadow(ctx, parseShadows(ps.boxShadow).pop(), scale);
        ctx.fillStyle = ps.backgroundColor;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        const shine = ctx.createRadialGradient(cx - r * 0.32, cy - r * 0.36, 0, cx - r * 0.32, cy - r * 0.36, r * 0.84);
        shine.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
        shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = shine;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (part.classList.contains('note-meta')) {
        for (const bit of part.children) drawText(ctx, bit, bit.offsetLeft, bit.offsetTop, bit.textContent);
      } else {
        drawText(ctx, part, part.offsetLeft, part.offsetTop, part.textContent, { clamp: part.classList.contains('note-text') });
      }
    }
    ctx.restore();
  }
}

// Draws the viewport as it is now. The canvas is the viewport's size in
// device pixels, so it is exactly what the person sees, as sharp as their
// screen shows it.
export async function renderView({ viewport, world, view, board }) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const rect = viewport.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = getComputedStyle(viewport).backgroundColor;
  ctx.fillRect(0, 0, rect.width, rect.height);

  const scale = view.zoom * dpr;
  ctx.translate(view.x, view.y);
  ctx.scale(view.zoom, view.zoom);
  drawBoardSurface(ctx, world, board.width, board.height, scale);
  drawGroups(ctx, world.querySelector('#groups'), scale);
  drawPaths(ctx, world.querySelectorAll('#ink-strokes path'), scale, false);
  drawPaths(ctx, world.querySelectorAll('#string-lines .string-line'), scale, true);
  drawTexts(ctx, world.querySelector('#texts'));
  drawNotes(ctx, world.querySelector('#notes'), scale);
  return canvas;
}

// ---------------------------------------------------------------- the PDF

// The PDF uses the standard Helvetica font, which covers Western European
// text. Anything outside it (emoji, other scripts) becomes "?" rather than
// garbage, and typographic punctuation is mapped to plain equivalents.
function pdfText(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-')
    .replace(/[   ]/g, ' ')
    .replace(/\r/g, '')
    .replace(/[^\n\x20-\x7E¡-ÿ]/gu, '?');
}

const INK = [32, 34, 38];
const GREY = [104, 110, 120];
const ACCENT = [36, 98, 166];

export function buildNotesPdf(jsPDF, { tabs, ideas, groups, texts, sketches, comments, tabOf, exportedBy }) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const page = { width: doc.internal.pageSize.getWidth(), height: doc.internal.pageSize.getHeight(), margin: 56 };
  const textWidth = page.width - page.margin * 2;
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });
  let y = page.margin;

  const room = (height) => {
    if (y + height > page.height - page.margin - 16) {
      doc.addPage();
      y = page.margin;
    }
  };
  const write = (text, { size = 10.5, style = 'normal', color = INK, indent = 0, after = 4, leading = 1.35 } = {}) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lineHeight = size * leading;
    for (const line of doc.splitTextToSize(pdfText(text), textWidth - indent)) {
      room(lineHeight);
      doc.text(line, page.margin + indent, y + size * 0.86);
      y += lineHeight;
    }
    y += after;
  };
  const rule = (color = [214, 218, 224]) => {
    room(8);
    doc.setDrawColor(...color);
    doc.setLineWidth(0.6);
    doc.line(page.margin, y, page.width - page.margin, y);
    y += 10;
  };

  const commentCount = [...comments.values()].reduce((sum, list) => sum + list.length, 0);
  write('FEDI Boards', { size: 22, style: 'bold', after: 2 });
  write(`Every idea and comment, exported ${day.format(new Date())} by ${exportedBy}.`, { size: 10, color: GREY, after: 2 });
  write(`${tabs.length} ${tabs.length === 1 ? 'board' : 'boards'}, ${ideas.length} ${ideas.length === 1 ? 'idea' : 'ideas'}, ${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}.`, { size: 10, color: GREY, after: 14 });

  const titleOf = new Map(ideas.map((idea) => [idea.number, idea.title]));
  const connections = new Map(ideas.map((idea) => [idea.number, new Set()]));
  for (const idea of ideas) {
    for (const link of idea.links || []) {
      if (!connections.has(link.to)) continue;
      connections.get(idea.number).add(link.to);
      connections.get(link.to).add(idea.number);
    }
  }

  tabs.forEach((tab, index) => {
    if (index > 0) y += 10;
    room(60);
    write(tab.name, { size: 16, style: 'bold', after: 2 });
    rule([170, 176, 186]);

    const here = ideas.filter((idea) => tabOf(idea) === tab.id);
    const tabGroups = groups.filter((group) => tabOf(group) === tab.id);
    const sections = [
      ...tabGroups.map((group) => ({ title: `Group: ${group.name}`, ideas: here.filter((idea) => idea.group === group.number) })),
      { title: tabGroups.length ? 'Not in a group' : null, ideas: here.filter((idea) => !tabGroups.some((group) => group.number === idea.group)) },
    ].filter((section) => section.ideas.length);

    if (!here.length) write('No ideas on this board.', { color: GREY, after: 8 });

    for (const section of sections) {
      if (section.title) {
        room(40);
        write(section.title, { size: 11, style: 'bold', color: ACCENT, after: 6 });
      }
      for (const idea of [...section.ideas].sort((a, b) => a.created.localeCompare(b.created))) {
        room(54);
        write(idea.title, { size: 12.5, style: 'bold', after: 1 });
        const linked = [...connections.get(idea.number)].map((n) => titleOf.get(n)).filter(Boolean);
        const meta = [`Posted by ${idea.author}, ${when.format(new Date(idea.created))}`];
        if (linked.length) meta.push(`Connected to: ${linked.join('; ')}`);
        write(meta.join('   |   '), { size: 8.5, color: GREY, after: 4 });
        if (idea.text) write(idea.text, { after: 6 });
        const thread = comments.get(idea.number) || [];
        if (thread.length) {
          write(`Comments (${thread.length})`, { size: 9, style: 'bold', color: GREY, indent: 14, after: 3 });
          for (const comment of thread) {
            room(28);
            write(`${comment.author}, ${when.format(new Date(comment.created))}`, { size: 8.5, style: 'bold', color: GREY, indent: 14, after: 1 });
            write(comment.text, { size: 10, indent: 14, after: 6 });
          }
        }
        y += 4;
        rule();
      }
    }

    const writing = texts.filter((item) => tabOf(item) === tab.id);
    if (writing.length) {
      room(40);
      write('Written on the board', { size: 11, style: 'bold', color: ACCENT, after: 6 });
      for (const item of writing) write(`"${item.text}"  - ${item.author}`, { after: 5 });
    }
    const drawings = sketches.filter((item) => tabOf(item) === tab.id).length;
    if (drawings) {
      write(`This board also has ${drawings === 1 ? '1 drawing, which only appears' : `${drawings} drawings, which only appear`} on the board.`, { size: 9, color: GREY, after: 4 });
    }
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...GREY);
    doc.text(`FEDI Boards  -  page ${i} of ${pages}`, page.width / 2, page.height - 28, { align: 'center' });
  }
  return doc;
}
