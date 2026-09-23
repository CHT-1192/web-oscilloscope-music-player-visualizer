#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-theme.js — the accent colour must reach every
    translucent fill.

    --accent is swapped at runtime, so anything tinted by it has to be DERIVED
    from it. .track.active was not: its border read var(--accent) while its fill
    was a literal rgba() of the default green, so picking red left a green wash
    under a red outline. The computed paint is probed, not the stylesheet text.
   ========================================================================== */

const h = require('../harness.js');
const { ok, bad } = h;

async function theme(ctx) {
  const { page } = ctx;

  /* ---- the theme colour must reach every translucent accent -----------
     `--accent` is swapped at runtime, so anything tinted by it has to be
     DERIVED from it. `.track.active` was not: its border read var(--accent)
     while its fill was a literal rgba() of the DEFAULT green, so picking a
     different colour left a green wash under a red outline. Same bug in the
     pressed toggles. Probe the computed paint, not the stylesheet text. */
  const accentPaint = () => page.evaluate(() => {
    /* Chrome serialises a color-mix() result as `color(srgb 1 0.41 0.54 / 0.07)`
       rather than rgba(), so both forms have to be understood — a parser that
       only knew rgb() would report "0 tinted elements" and quietly turn this
       check into a no-op. */
    const parse = (s) => {
      const str = String(s);
      const srgb = str.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\)$/);
      if (srgb) {
        return {
          r: Math.round(parseFloat(srgb[1]) * 255),
          g: Math.round(parseFloat(srgb[2]) * 255),
          b: Math.round(parseFloat(srgb[3]) * 255),
          a: srgb[4] === undefined ? 1 : parseFloat(srgb[4]),
        };
      }
      const m = str.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    /* Resolve the custom property through a real property: getPropertyValue on
       a custom property hands back the raw token, '#7ef9ff', not channels. */
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const accent = parse(getComputedStyle(probe).color);
    probe.remove();

    const sample = (sel, prop) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const paint = prop === 'border' ? cs.borderBottomColor : cs.backgroundColor;
      return { sel, ...(parse(paint) || { r: -1, g: -1, b: -1, a: 0 }) };
    };

    /* Every target is required: a selector that stops matching would otherwise
       shrink the sample silently instead of failing. */
    const wanted = [
      ['.track.active', 'background'],
      ['.pills [aria-pressed="true"]', 'background'],
      ['.link', 'border'],
    ];
    const parts = [];
    const missing = [];
    for (const [sel, prop] of wanted) {
      const s = sample(sel, prop);
      if (s && s.a > 0) parts.push(s);
      else missing.push(sel);
    }
    return { accent, parts, missing };
  });

  const offColour = async (hex) => {
    await page.evaluate((c) => {
      const el = document.querySelector('[data-set="color"]');
      el.value = c;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, hex);
    await page.waitForTimeout(250);
    return accentPaint();
  };

  const themeRed = await offColour('#ff6b8a');
  const themeGreen = await offColour('#3dff9c');
  await page.evaluate(() => document.getElementById('btnReset').click());
  await page.waitForTimeout(300);

  const mismatched = (probe) => probe.parts.filter((p) => (
    Math.abs(p.r - probe.accent.r) > 1
    || Math.abs(p.g - probe.accent.g) > 1
    || Math.abs(p.b - probe.accent.b) > 1
  ));

  const themeLabel = 'selected track / toggle fills follow the theme colour';
  if (themeRed.missing.length === 0) {
    const wrong = mismatched(themeRed);
    if (wrong.length === 0) {
      ok(themeLabel, `${themeRed.parts.length} fills tinted rgb(${themeRed.accent.r},${themeRed.accent.g},${themeRed.accent.b}) — ${themeRed.parts.map((p) => p.sel).join(', ')}`);
    } else {
      bad(themeLabel,
        wrong.map((p) => `${p.sel} stayed rgb(${p.r},${p.g},${p.b}) while the accent is rgb(${themeRed.accent.r},${themeRed.accent.g},${themeRed.accent.b})`).join(' | '));
    }
  } else {
    bad(themeLabel, `no tinted paint found on ${themeRed.missing.join(', ')}`);
  }

  /* Control: with the default green the fill and the accent must still agree,
     so the check above is not passing merely because nothing is painted. */
  const controlLabel = 'control: same fills still track the default green';
  if (themeGreen.missing.length === 0 && mismatched(themeGreen).length === 0) {
    ok(controlLabel, `${themeGreen.parts.length} fills`);
  } else {
    bad('control: same fills still track the default green', JSON.stringify(themeGreen.parts));
  }
}

module.exports = theme;
