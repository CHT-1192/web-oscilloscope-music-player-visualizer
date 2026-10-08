import * as core from './core.js';

/* ============================================================================
    media.js — the operating system's side of the transport.

    The keyboard's media keys (F7 / F8 / F9 on a Mac) are not ordinary keys. The
    system routes them to whatever claims the "now playing" session, which is why
    a page that only listens for keydown keeps them while the window has focus
    and loses them the moment it does not. navigator.mediaSession IS that claim:
    the handlers below make the keys, the Control Center buttons and the Touch Bar
    drive this transport, and the metadata is what that panel shows.

    The artwork is the live figure. The same canvas the app paints goes into a
    512x512 square every ART_MS while something is playing, so the Now Playing
    tile is the scope rather than a blank square. Measured in Chromium: the keys
    also arrive as ordinary keydown events (`key === 'MediaPlayPause'`) targeted
    at whatever has focus, which ui.js handles for the focused case; neither path
    assumes the other.

    Nothing here knows what the transport is: whoever owns it installs hooks.
   ========================================================================== */

const ART_MS = 20000;
const ART_PX = 512;

let hooks = null;
let session = null;
let now = { title: '', artist: '', album: '示波器音乐播放器' };
let artUrl = '';
let playing = false;
let artTimer = 0;

const ok = () => typeof navigator !== 'undefined' && !!navigator.mediaSession;

/** Hand over the transport. Every hook is optional; a missing one means that
    action is simply not handled, which is better than a handler that throws. */
function install(h) {
  hooks = h;
  session = ok() ? navigator.mediaSession : null;
  if (!session) return false;
  const on = (name, fn) => {
    try { session.setActionHandler(name, fn); } catch (err) { /* action unknown here */ }
  };
  on('play', () => hooks.play && hooks.play());
  on('pause', () => hooks.pause && hooks.pause());
  on('stop', () => hooks.pause && hooks.pause());
  on('previoustrack', () => hooks.prev && hooks.prev());
  on('nexttrack', () => hooks.next && hooks.next());
  on('seekbackward', (d) => hooks.seekBy && hooks.seekBy(-((d && d.seekOffset) || 5)));
  on('seekforward', (d) => hooks.seekBy && hooks.seekBy((d && d.seekOffset) || 5));
  on('seekto', (d) => hooks.seekTo && d && Number.isFinite(d.seekTime) && hooks.seekTo(d.seekTime));
  /* Clearing an action handler is how a browser is told the action is gone; a
     missing hook would otherwise leave a button that does nothing. */
  for (const [name, fn] of [['play', hooks.play], ['pause', hooks.pause], ['nexttrack', hooks.next], ['previoustrack', hooks.prev]]) {
    if (!fn) on(name, null);
  }
  if (!artTimer) artTimer = window.setInterval(() => { if (playing) paint(); }, ART_MS);
  return true;
}

function push() {
  if (!session || typeof window.MediaMetadata !== 'function') return;
  try {
    session.metadata = new window.MediaMetadata({
      title: now.title,
      artist: now.artist,
      album: now.album,
      artwork: artUrl ? [{ src: artUrl, sizes: `${ART_PX}x${ART_PX}`, type: 'image/png' }] : [],
    });
  } catch (err) { /* metadata is advisory; never let it break the transport */ }
}

/** What the panel says is playing. Called on every track change. */
function setTrack(t) {
  now = {
    title: (t && t.title) || '',
    artist: (t && t.artist) || '',
    album: (t && t.album) || '示波器音乐播放器',
  };
  push();
  if (playing) paint();
}

/** Derived, never accumulated from events. The transport readout calls this with
    the element's own state, so an event delivered late — or from an <audio> that
    was already replaced by an engine rebuild — cannot leave the panel lying. */
function setPlaying(on) {
  const next = !!on;
  if (next === playing) return;
  playing = next;
  if (session) {
    try { session.playbackState = playing ? 'playing' : 'paused'; } catch (err) { /* ignore */ }
  }
  if (playing) paint();
}

/** The OS progress bar. Called from the transport readout, so it is throttled
    there; a state that breaks the rules (position past duration) throws, and a
    stale progress bar is better than an exception every second. */
function setPosition(duration, position, rate) {
  if (!session || !session.setPositionState) return;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
  try {
    session.setPositionState({
      duration,
      position: core.clamp(position, 0, duration),
      playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1,
    });
  } catch (err) { /* ignore */ }
}

function paint() {
  if (!hooks || !hooks.frame) return;
  const src = hooks.frame();
  if (!src || !src.width || !src.height) return;
  const c = document.createElement('canvas');
  c.width = ART_PX;
  c.height = ART_PX;
  const g = c.getContext('2d');
  /* The plot is square but the canvas is not: take the middle square rather than
     squashing the figure. */
  const s = Math.min(src.width, src.height);
  g.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, ART_PX, ART_PX);
  c.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const old = artUrl;
    artUrl = url;
    push();
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  }, 'image/png');
}

export {
  ART_MS,
  ART_PX,
  install,
  setPlaying,
  setPosition,
  setTrack,
};
