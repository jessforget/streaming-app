/*
 * Lower-third styles (see lt.css): their names, how each is built, and how a look is put on a
 * page. Used by the graphics page (/live) and the gfx app's style picker. window.GfxLT.
 */
;(() => {
  const STYLES = [
    { id: 'classic', name: 'Classic', old: true, tags: ['clean'], about: 'Name bar over a colour title bar.', colors: { box: '#f2f2f2', text: '#111111' } },
    { id: 'block', name: 'Bold block', old: true, tags: ['clean'], about: 'Box with a colour stripe, name in capitals.', colors: { box: '#0c0e12', text: '#ffffff' } },
    { id: 'minimal', name: 'Minimal', old: true, tags: ['clean'], about: 'Just the words and a short line.', colors: { box: '#000000', text: '#ffffff' }, noBox: true },
    { id: 'news', name: 'News strip', old: true, tags: ['news'], about: 'Full-width strip with a LIVE tag.', colors: { box: '#f5f6f8', text: '#111111' } },
    { id: 'reveal', name: 'Wipe reveal', tags: ['news'], about: 'A colour block sweeps across and uncovers the text.', colors: { box: '#f2f2f2', text: '#111111' } },
    { id: 'split', name: 'Split', tags: ['sports'], about: 'Name flies in from the left, title from the right.', colors: { box: '#f2f2f2', text: '#111111' } },
    { id: 'glass', name: 'Glass', tags: ['clean'], about: 'Frosted see-through panel that rises in.', colors: { box: '#ffffff', text: '#ffffff' }, noBox: true },
    { id: 'angled', name: 'Angled sport', tags: ['sports'], about: 'Slanted bars in capitals. Wipes in fast.', colors: { box: '#0b0d12', text: '#ffffff' } },
    { id: 'letters', name: 'Letter by letter', tags: ['social'], about: 'Each letter pops up, then a line draws under.', colors: { box: '#000000', text: '#ffffff' }, noBox: true },
    { id: 'type', name: 'Typewriter', tags: ['social'], about: 'The name types itself out with a blinking cursor.', colors: { box: '#0b0d12', text: '#ffffff' } },
    { id: 'pill', name: 'Social pill', tags: ['social'], about: 'Round badge with initials and a handle.', colors: { box: '#ffffff', text: '#111111' } },
    { id: 'bracket', name: 'Corner brackets', tags: ['clean'], about: 'Two corners close in around the text.', colors: { box: '#000000', text: '#ffffff' }, noBox: true },
    { id: 'fade', name: 'Soft fade', tags: ['clean', 'news'], about: 'Dark fade across the bottom, the text rises.', colors: { box: '#000000', text: '#ffffff' }, noBox: true },
    { id: 'ribbon', name: 'Ribbons', tags: ['sports'], about: 'Two cut-corner ribbons unroll one after the other.', colors: { box: '#f2f2f2', text: '#111111' } },
    { id: 'center', name: 'Centered heading', tags: ['news'], about: 'Centered title with lines that grow out. Good for topics.', colors: { box: '#000000', text: '#ffffff' }, noBox: true },
    { id: 'vbar', name: 'Behind the bar', tags: ['clean', 'news'], about: 'Text slides out from behind a thick colour bar.', colors: { box: '#0b0d12', text: '#ffffff' } }
  ]
  const byId = (id) => STYLES.find((s) => s.id === id) ?? STYLES[0]
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const initials = (n) =>
    String(n)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => [...w][0])
      .join('')
      .toUpperCase()

  /** The lower third's inside (the .l3) for one style, with these words. */
  function html(style, name, title) {
    const n = esc(name)
    const t = esc(title)
    switch (style) {
      case 'block': return `<div class="l3"><div class="inner"><div class="name">${n}</div><div class="title">${t}</div></div></div>`
      case 'minimal': return `<div class="l3"><div class="name">${n}</div><div class="line"></div><div class="title">${t}</div></div>`
      case 'news': return `<div class="l3"><div class="tag">LIVE</div><div class="band"><div class="name">${n}</div><div class="divider"></div><div class="title">${t}</div></div></div>`
      case 'reveal': return `<div class="l3"><div class="w"><div class="name">${n}</div></div><div class="w"><div class="title">${t}</div></div></div>`
      case 'split': case 'ribbon': return `<div class="l3"><div class="name">${n}</div><div class="title">${t}</div></div>`
      case 'glass': return `<div class="l3"><div class="name">${n}</div><div class="title">${t}</div></div>`
      case 'angled': return `<div class="l3"><div class="name"><span>${n}</span></div><div class="title"><span>${t}</span></div></div>`
      case 'letters': return `<div class="l3"><div class="name">${[...String(name)].map((c, i) => `<span style="--i:${i}">${esc(c)}</span>`).join('')}</div><i class="line"></i><div class="title">${t}</div></div>`
      case 'type': return `<div class="l3"><div><span class="name" style="--n:${Math.max(1, [...String(name)].length)}">${n}</span><span class="cur"></span></div><div class="title">${t}</div></div>`
      case 'pill': return `<div class="l3"><div class="av">${esc(initials(name))}</div><div><div class="name">${n}</div><div class="title">${t}</div></div></div>`
      case 'bracket': return `<div class="l3"><i class="c c1"></i><i class="c c2"></i><div class="name">${n}</div><div class="title">${t}</div></div>`
      case 'fade': return `<div class="l3"><div class="name">${n}</div><div class="title">${t}</div></div>`
      case 'center': return `<div class="l3"><div class="row"><i></i><div class="name">${n}</div><i></i></div><div class="title">${t}</div></div>`
      case 'vbar': return `<div class="l3"><i class="bar"></i><div class="m"><div class="in"><div class="name">${n}</div><div class="title">${t}</div></div></div></div>`
      default: return `<div class="l3"><div class="name">${n}</div><div class="title">${t}</div></div>`
    }
  }

  const FONT_STACK = { 'JetBrains Mono': "'JetBrains Mono'" }
  /** Put a look's fonts, sizes and colours on an element (the stage or a preview card). */
  function applyLook(el, look) {
    const s = el.style
    const font = look.font === 'custom' ? look.customFont || 'Segoe UI' : look.font
    s.setProperty('--font', FONT_STACK[font] ?? `'${font}'`)
    s.setProperty('--name-size', `${(look.nameSize ?? 52) / 19.2}cqw`)
    s.setProperty('--title-size', `${(look.titleSize ?? 30) / 19.2}cqw`)
    s.setProperty('--accent', look.accent ?? '#2563d9')
    s.setProperty('--box', look.box ?? '#f2f2f2')
    s.setProperty('--text', look.text ?? '#111111')
    s.setProperty('--sp', String({ slow: 1.6, fast: 0.6 }[look.speed] ?? 1))
    if (look.length > 0) s.setProperty('--width', `${look.length}cqw`)
    else s.removeProperty('--width')
  }
  /** The .place's classes for a look (add ' on' to show it). */
  function placeClass(look) {
    const st = byId(look.style)
    return st.old ? `place old ${st.id} ${look.position ?? 'left'} anim-${look.animation ?? 'slide'}` : `place new s-${st.id} ${look.position ?? 'left'}`
  }

  window.GfxLT = { STYLES, byId, html, applyLook, placeClass, esc }
})()
