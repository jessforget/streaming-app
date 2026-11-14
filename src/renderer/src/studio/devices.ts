/**
 * The cameras, capture cards and audio devices this PC's browser can open,
 * with their real names: the ATEM Mini shows as "Blackmagic Design", a Zoom
 * L-12 as "ZOOM L-12 Audio · Microphone".
 */
import { audioDeviceName, type InputDevice } from '../../../shared/state'

/** Chrome adds the USB ids to some names, "Blackmagic Design (1edb:be55)". People don't need them. */
const cleanName = (label: string) => label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim()

/** Browsers add these pretend devices that follow Windows' default; we list the real ones only. */
const PSEUDO = new Set(['default', 'communications', ''])

const channelCache = new Map<string, number>()

/** Ask once for permission to see device names. Without it the browser lists devices with no names. */
async function ensurePermission(list: MediaDeviceInfo[]) {
  if (list.every((d) => d.label)) return
  for (const constraints of [{ audio: true, video: true }, { audio: true }, { video: true }]) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints)
      s.getTracks().forEach((t) => t.stop())
      return
    } catch {
      // no such device, or the person said no: try the next combination
    }
  }
}

/** How many input channels an audio device offers (a Zoom L-12 can offer more than 2 on some PCs). */
async function probeChannels(deviceId: string): Promise<number> {
  const known = channelCache.get(deviceId)
  if (known) return known
  let n = 2
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, channelCount: { ideal: 32 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    })
    n = s.getAudioTracks()[0]?.getSettings().channelCount ?? 2
    s.getTracks().forEach((t) => t.stop())
  } catch {
    // busy or unplugged: assume a stereo pair
  }
  channelCache.set(deviceId, n)
  return n
}

export async function listDevices(): Promise<{ video: InputDevice[]; audio: InputDevice[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { video: [], audio: [] }
  let list = await navigator.mediaDevices.enumerateDevices()
  await ensurePermission(list)
  list = await navigator.mediaDevices.enumerateDevices()
  const video = list
    .filter((d) => d.kind === 'videoinput' && !PSEUDO.has(d.deviceId))
    .map((d, i) => ({ id: d.deviceId, name: cleanName(d.label) || `Camera ${i + 1}`, group: d.groupId }))
  const audio: InputDevice[] = []
  for (const [i, d] of list.filter((x) => x.kind === 'audioinput' && !PSEUDO.has(x.deviceId)).entries()) {
    audio.push({
      id: d.deviceId,
      name: audioDeviceName(cleanName(d.label)) || `Audio input ${i + 1}`,
      driver: 'wasapi',
      group: d.groupId,
      channels: await probeChannels(d.deviceId)
    })
  }
  return { video, audio }
}

/** Call `fn` when a device is plugged in or unplugged. */
export function onDeviceChange(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const handler = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, 500)
  }
  navigator.mediaDevices?.addEventListener('devicechange', handler)
  return () => navigator.mediaDevices?.removeEventListener('devicechange', handler)
}
