import { afterEach, describe, expect, it, vi } from 'vitest'

// GfxLink makes a small canvas when it is built; a stand-in is enough here.
;(globalThis as { document?: unknown }).document = { createElement: () => ({}), visibilityState: 'visible' }

const { GfxLink } = await import('../src/renderer/src/studio/gfxlink')

type Posted = { take: number; status: string }

function setup() {
  const posts: Posted[] = []
  let onCue: ((c: unknown) => void) | null = null
  ;(globalThis as { desktopGraphics?: unknown }).desktopGraphics = {
    onCue: (fn: (c: unknown) => void) => ((onCue = fn), () => {}),
    copyCue: async (url: string) => `C:/commercials/${url.split('/').pop()}.mp4`,
    post: (_o: string, path: string, body: Posted) => path === '/api/cue' && posts.push(body)
  }
  const layer = (id: string, visible: boolean) => ({ id, kind: 'media', url: `C:/commercials/${id}.mp4`, visible })
  // The break on air: a (playing) and b.
  let state = { programSceneId: 'gc', scenes: [{ id: 'gc', commercial: true, layers: [layer('a', true), layer('b', false)] }] }
  const bridge = {
    // The command's answer comes first; the state with the longer break follows (as from the server; a busy PC can take a while).
    command: vi.fn(async () => {
      setTimeout(() => (state = { ...state, scenes: [{ ...state.scenes[0], layers: [layer('a', true), layer('b', false), layer('c', false)] }] }), 300)
      return { ok: true }
    })
  }
  const link = new GfxLink(bridge as never, () => state as never, () => false, () => null, () => {})
  link.start()
  return { posts, link, cue: (c: unknown) => onCue?.(c) }
}

afterEach(() => vi.useRealTimers())

describe('a break on air that gets longer', () => {
  it('stays on air in the gfx app while the new state is on its way', async () => {
    vi.useFakeTimers()
    const { posts, link, cue } = setup()
    const o = 'http://gfx:8765'
    const url = (id: string) => `${o}/media/${id}`
    // Cue the first break and put it on air (its state is already the one above).
    ;(link as unknown as { cue: unknown }).cue = { origin: o, take: 1, paths: ['C:/commercials/a.mp4', 'C:/commercials/b.mp4'], status: 'onair', since: 0, seen: true }
    await vi.advanceTimersByTimeAsync(250)
    expect(posts.at(-1)?.status).toBe('onair')
    // A video dropped into the list while it plays.
    cue({ origin: o, take: 2, onAir: true, items: ['a', 'b', 'c'].map((id) => ({ name: id, url: url(id) })) })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(posts.some((p) => p.status === 'done' || p.status === 'cleared')).toBe(false)
    expect(posts.at(-1)).toMatchObject({ take: 2, status: 'onair' })
    link.stop()
  })
})
