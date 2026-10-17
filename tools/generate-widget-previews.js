/* eslint-disable no-console */

/**
 * Generates the widget preview images required by the Homey App Store (guideline 1.10):
 * 1024x1024 PNG, transparent background, simple shapes, no readable text, one image per colour scheme.
 *
 * Usage:  node tools/generate-widget-previews.js
 * Needs:  sharp  (npm i --no-save sharp)
 *
 * The drawing is an abstract skeleton of widgets/household/public/index.html:
 * pet cards with a status ring, a pet door card with the lock-mode control, and a water level bar.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function loadSharp() {
  const candidates = ['sharp', path.join(os.tmpdir(), 'sp-raster', 'node_modules', 'sharp')];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      return require(candidate);
    } catch (err) {
      // try the next location
    }
  }
  throw new Error('sharp is not installed. Run: npm i --no-save sharp');
}

const SIZE = 1024;
const OUT_DIR = path.join(__dirname, '..', 'widgets', 'household');

const ACCENT = {
  green: '#2DB36A',
  blue: '#2F7CF6',
  orange: '#F59E0B',
  red: '#E5484D',
};

const THEMES = {
  dark: {
    file: 'preview-dark.png',
    frame: '#2A2C31',
    frameStroke: 'rgba(255,255,255,0.08)',
    skeleton: 'rgba(255,255,255,0.20)',
    skeletonSoft: 'rgba(255,255,255,0.11)',
    line: 'rgba(255,255,255,0.12)',
    segment: 'rgba(255,255,255,0.06)',
    shadow: '#000000',
    shadowOpacity: 0.45,
  },
  light: {
    file: 'preview-light.png',
    frame: '#FFFFFF',
    frameStroke: 'rgba(0,0,0,0.06)',
    skeleton: 'rgba(0,0,0,0.16)',
    skeletonSoft: 'rgba(0,0,0,0.08)',
    line: 'rgba(0,0,0,0.10)',
    segment: 'rgba(0,0,0,0.04)',
    shadow: '#1B2A4A',
    shadowOpacity: 0.22,
  },
};

function rect(x, y, w, h, r, fill, extra = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
}

function pill(x, y, w, h, fill) {
  return rect(x, y, w, h, h / 2, fill);
}

function card(theme, x, y, w, h) {
  return rect(x + 1, y + 1, w - 2, h - 2, 26, 'none', `stroke="${theme.line}" stroke-width="2"`);
}

function chevron(theme, cx, cy) {
  return `<path d="M${cx - 10} ${cy - 5} L${cx} ${cy + 6} L${cx + 10} ${cy - 5}" fill="none" stroke="${theme.skeleton}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function battery(theme, x, y, level) {
  return [
    rect(x, y, 44, 22, 6, 'none', `stroke="${theme.skeleton}" stroke-width="3"`),
    rect(x + 46, y + 6, 4, 10, 2, theme.skeleton),
    rect(x + 6, y + 6, Math.round(32 * level), 10, 3, theme.skeleton),
  ].join('');
}

function petCard(theme, x, y, w, ring) {
  const h = 96;
  return [
    card(theme, x, y, w, h),
    `<circle cx="${x + 56}" cy="${y + 48}" r="30" fill="${theme.skeletonSoft}" stroke="${ring}" stroke-width="6"/>`,
    pill(x + 104, y + 30, 116, 18, theme.skeleton),
    pill(x + 104, y + 58, 80, 14, theme.skeletonSoft),
    chevron(theme, x + w - 36, y + 48),
  ].join('');
}

function build(theme) {
  const fx = 112;
  const fw = 800;
  const fh = 644;
  const fy = (SIZE - fh) / 2;
  const px = fx + 40;
  const pw = fw - 80;
  const parts = [];

  parts.push(`
    <defs>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
        <feDropShadow dx="0" dy="22" stdDeviation="26" flood-color="${theme.shadow}" flood-opacity="${theme.shadowOpacity}"/>
      </filter>
    </defs>`);

  parts.push(rect(fx, fy, fw, fh, 56, theme.frame, 'filter="url(#shadow)"'));
  parts.push(rect(fx + 1, fy + 1, fw - 2, fh - 2, 55, 'none', `stroke="${theme.frameStroke}" stroke-width="2"`));

  let y = fy + 40;

  // Pets
  parts.push(pill(px, y, 110, 16, theme.skeletonSoft));
  y += 36;
  const petW = (pw - 24) / 2;
  parts.push(petCard(theme, px, y, petW, ACCENT.green));
  parts.push(petCard(theme, px + petW + 24, y, petW, ACCENT.blue));
  y += 96 + 32;

  // Pet door with lock-mode control
  parts.push(pill(px, y, 140, 16, theme.skeletonSoft));
  y += 36;
  const doorH = 184;
  parts.push(card(theme, px, y, pw, doorH));
  parts.push(pill(px + 28, y + 30, 168, 18, theme.skeleton));
  parts.push(pill(px + 28, y + 58, 220, 14, theme.skeletonSoft));
  parts.push(pill(px + pw - 300, y + 34, 96, 28, `${ACCENT.green}38`));
  parts.push(battery(theme, px + pw - 190, y + 37, 0.7));
  parts.push(chevron(theme, px + pw - 40, y + 48));

  const segCount = 5;
  const segGap = 12;
  const segW = (pw - 56 - segGap * (segCount - 1)) / segCount;
  for (let i = 0; i < segCount; i += 1) {
    const sx = px + 28 + i * (segW + segGap);
    parts.push(rect(sx, y + 112, segW, 56, 16, i === 0 ? ACCENT.blue : theme.segment, i === 0 ? '' : `stroke="${theme.line}" stroke-width="2"`));
    parts.push(pill(sx + segW / 2 - 26, y + 112 + 21, 52, 14, i === 0 ? 'rgba(255,255,255,0.85)' : theme.skeletonSoft));
  }
  y += doorH + 32;

  // Water level
  parts.push(pill(px, y, 150, 16, theme.skeletonSoft));
  y += 36;
  parts.push(card(theme, px, y, pw, 112));
  parts.push(pill(px + 28, y + 28, 148, 18, theme.skeleton));
  parts.push(pill(px + pw - 190, y + 25, 74, 24, `${ACCENT.orange}38`));
  parts.push(battery(theme, px + pw - 104, y + 26, 0.45));
  parts.push(pill(px + 28, y + 66, pw - 56, 16, theme.segment));
  parts.push(pill(px + 28, y + 66, Math.round((pw - 56) * 0.58), 16, ACCENT.blue));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${parts.join('')}</svg>`;
}

async function main() {
  const sharp = loadSharp();

  for (const [name, theme] of Object.entries(THEMES)) {
    const svg = build(theme);
    if (/<text[\s>]/i.test(svg)) {
      throw new Error('Previews must not contain text');
    }

    const target = path.join(OUT_DIR, theme.file);
    // eslint-disable-next-line no-await-in-loop
    await sharp(Buffer.from(svg)).png().toFile(target);

    // Self-check: size, alpha channel and a transparent corner.
    // eslint-disable-next-line no-await-in-loop
    const { data, info } = await sharp(target).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== SIZE || info.height !== SIZE || info.channels !== 4) {
      throw new Error(`${theme.file}: expected ${SIZE}x${SIZE} RGBA, got ${info.width}x${info.height}x${info.channels}`);
    }
    if (data[3] !== 0) {
      throw new Error(`${theme.file}: background is not transparent`);
    }
    console.log(`${name}: ${target} (${fs.statSync(target).size} bytes, ${info.width}x${info.height}, transparent)`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
