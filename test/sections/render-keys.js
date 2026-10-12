const h = require('../harness.js');
const { ok, bad } = h;

async function keys(ctx) {
  const { page } = ctx;


  /* ==========================================================================
     The keyboard and the operating system's transport.

     Everything here changes the TRANSPORT — it plays tracks, switches them, mutes
     things and asks the engine to rebuild at another sample rate — so it runs as
     the LAST scene. Left in the middle it broke the pixel scenes after it: the
     picture they measured was no longer the synthetic pattern at all, and only in
     a full-suite run, which is exactly the kind of thing a scene order must not
     decide.
     ======================================================================== */
  const paused = () => page.evaluate(() => document.getElementById('audio').paused);
  const leaveDemo = () => page.evaluate(() => {
    if (window.__scope.state.source === 'demo') document.getElementById('btnDemo').click();
    document.getElementById('audio').pause();
    document.getElementById('volume').focus();
  });
  const backToDemo = () => page.evaluate(() => {
    if (window.__scope.state.source === 'media') document.getElementById('btnDemo').click();
  });

  /* The shortcut table in the README was dead: onKey survived the module split
     and nothing bound it. Assert one shortcut that is observable without
     console spying, so the table cannot rot again. */
  const volBefore = await page.inputValue('#volume');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  await page.waitForTimeout(200);
  const volAfter = await page.inputValue('#volume');
  if (Number(volAfter) > Number(volBefore)) {
    ok('the keyboard shortcuts are bound', `音量 ${volBefore} → ${volAfter} on ArrowUp`);
  } else {
    bad('the keyboard shortcuts are bound', `${volBefore} → ${volAfter}`);
  }

  /* Whose keyboard is it when something has focus? A slider keeps focus after
     you drag it, and the guard used to treat any `input` as a text field, so
     after touching 音量 or the seek bar EVERY shortcut was swallowed — space did
     nothing until you clicked elsewhere. A reported bug, so it gets checks. */
  await leaveDemo();
  await page.waitForTimeout(300);
  const v0 = Number(await page.inputValue('#volume'));
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(250);
  const v1 = Number(await page.inputValue('#volume'));
  if (Math.abs(v1 - v0 - 0.05) < 1e-6) {
    ok('a focused slider no longer swallows the keys', `音量 ${v0} → ${v1} on ArrowUp with 音量 focused`);
  } else {
    bad('a focused slider no longer swallows the keys', `音量 ${v0} → ${v1} (wanted +0.05)`);
  }

  const wasPaused = await paused();
  await page.keyboard.press(' ');
  await page.waitForTimeout(500);
  const nowPaused = await paused();
  await page.keyboard.press(' ');                       // put the transport back
  await page.waitForTimeout(400);
  if (wasPaused === true && nowPaused === false) {
    ok('space plays with a transport slider focused', '音量 focused → playing');
  } else {
    bad('space plays with a transport slider focused', `paused ${wasPaused} → ${nowPaused}`);
  }

  /* Text entry keeps the keyboard: the playlist filter is typed in, and a space
     there is a space. */
  await page.evaluate(() => { if (!document.getElementById('panelList').classList.contains('open')) document.getElementById('btnList').click(); });
  await page.evaluate(() => { const el = document.getElementById('trackFilter'); el.value = ''; el.focus(); });
  await page.waitForTimeout(250);
  const pausedBeforeType = await paused();
  await page.keyboard.type('a b');
  await page.waitForTimeout(300);
  const typed = await page.evaluate(() => document.getElementById('trackFilter').value);
  if (typed === 'a b' && (await paused()) === pausedBeforeType) {
    ok('a space while typing stays a space', `filter "${typed}", transport untouched`);
  } else {
    bad('a space while typing stays a space', `filter "${typed}", paused ${pausedBeforeType} → ${await paused()}`);
  }
  await page.evaluate(() => {
    const el = document.getElementById('trackFilter');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    if (document.getElementById('panelList').classList.contains('open')) document.getElementById('btnList').click();
  });
  await backToDemo();
  await page.waitForTimeout(300);

  /* A composing IME owns the keyboard — for a Pinyin user that space commits a
     candidate — while an IME that is merely ENABLED reports the space as
     'Process' and it is still a space. */
  const strike = async (label, init, want) => {
    await leaveDemo();
    await page.waitForTimeout(250);
    const before = await paused();
    await page.evaluate((i) => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, i)));
    }, init);
    await page.waitForTimeout(400);
    const after = await paused();
    if (before !== after) await page.evaluate(() => document.getElementById('audio').pause());
    await backToDemo();
    if ((before !== after) === want) ok(label, `paused ${before} → ${after}`);
    else bad(label, `paused ${before} → ${after}, wanted ${want ? 'a toggle' : 'none'}`);
  };
  await strike('space with an enabled IME still plays', { key: 'Process', code: 'Space' }, true);
  await strike('a composing space is left to the IME', { key: ' ', code: 'Space', isComposing: true }, false);
  await strike('keyCode 229 is left to the IME', { key: ' ', code: 'Space', keyCode: 229 }, false);

  /* The keyboard's media keys (F7 / F8 / F9 on a Mac). Measured on a real F8:
     the system sends an ordinary keydown whose key is 'MediaPlayPause' and whose
     TARGET is whatever has focus — a text field or a slider — so a handler that
     respects focus loses them. And what the OS shows in its now-playing panel
     comes from navigator.mediaSession, metadata included. */
  const metaOf = () => page.evaluate(() => {
    const s = navigator.mediaSession;
    const m = s && s.metadata;
    const art = m && m.artwork && m.artwork.length ? m.artwork[0] : null;
    return {
      state: s ? s.playbackState : 'none',
      title: m ? m.title : '',
      artist: m ? m.artist : '',
      sizes: art ? art.sizes : '',
      src: art ? String(art.src).slice(0, 5) : '',
    };
  });

  await leaveDemo();
  await page.evaluate(() => {
    if (!document.getElementById('panelList').classList.contains('open')) document.getElementById('btnList').click();
    const el = document.getElementById('trackFilter');
    el.value = '';
    el.focus();
  });
  await page.waitForTimeout(400);
  const f8a = await paused();
  await page.keyboard.press('MediaPlayPause');
  await page.waitForTimeout(700);
  const f8b = await paused();
  const held = await page.evaluate(() => document.getElementById('trackFilter').value);
  if (f8a === true && f8b === false && held === '') {
    ok('F8 reaches the transport even from a text field', 'filter focused, transport playing');
  } else {
    bad('F8 reaches the transport even from a text field', `paused ${f8a} → ${f8b}, filter "${held}"`);
  }

  const title0 = await page.evaluate(() => document.getElementById('trackTitle').textContent);
  await page.keyboard.press('MediaTrackNext');
  await page.waitForTimeout(1200);
  const title1 = await page.evaluate(() => document.getElementById('trackTitle').textContent);
  const meta1 = await metaOf();
  if (title1 && title1 !== title0 && meta1.title === title1 && meta1.artist) {
    ok('F9 moves the track and the system panel follows', `${title0} → ${title1}, panel "${meta1.artist.slice(0, 28)}"`);
  } else {
    bad('F9 moves the track and the system panel follows', JSON.stringify({ title0, title1, meta1 }));
  }
  await page.keyboard.press('MediaTrackPrevious');
  await page.waitForTimeout(1400);

  const art = await page.evaluate(() => new Promise((res) => {
    const s = navigator.mediaSession;
    const a = s && s.metadata && s.metadata.artwork;
    if (!a || !a.length) return res(null);
    const img = new Image();
    img.onload = () => res([img.naturalWidth, img.naturalHeight, a[0].sizes]);
    img.onerror = () => res('load failed');
    img.src = a[0].src;
    setTimeout(() => res('timeout'), 4000);
  }));
  if (Array.isArray(art) && art[0] === 512 && art[1] === 512 && art[2] === '512x512') {
    ok('the now-playing tile is the live figure', `artwork ${art[0]}×${art[1]}, ${art[2]}`);
  } else {
    bad('the now-playing tile is the live figure', JSON.stringify(art));
  }

  const meta2 = await metaOf();
  if (meta2.state === 'playing' && /^blob:/.test(meta2.src)) {
    ok('the now-playing state matches the transport', `${meta2.state}, artwork ${meta2.src}…`);
  } else {
    bad('the now-playing state matches the transport', JSON.stringify(meta2));
  }

  await page.evaluate(() => {
    const el = document.getElementById('trackFilter');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    if (document.getElementById('panelList').classList.contains('open')) document.getElementById('btnList').click();
  });
  await backToDemo();
  await page.waitForTimeout(300);
}

module.exports = { keys };
