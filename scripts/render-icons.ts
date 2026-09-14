/**
 * Renders the PNG app icons from public/favicon.svg with the Chrome installed on
 * this machine (through Playwright), so the install icons always match the
 * favicon. Run with: npx tsx scripts/render-icons.ts
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
const outDir = new URL('../public/icons/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const BACKGROUND = '<rect width="64" height="64" rx="18" fill="url(#g)"/>';
if (!svg.includes(BACKGROUND)) throw new Error('favicon.svg changed: update the background rect in render-icons.ts');
const sized = (markup: string) => markup.replace('<svg ', '<svg width="100%" height="100%" ');

// Rounded icons keep the favicon's transparent corners. Full-bleed icons (maskable, Apple) fill the square
// and keep the mark inside the platform's safe zone.
const ICONS = [
  { file: 'icon-192.png', size: 192, bleed: false, scale: 1 },
  { file: 'icon-512.png', size: 512, bleed: false, scale: 1 },
  { file: 'maskable-512.png', size: 512, bleed: true, scale: 0.88 },
  { file: 'apple-touch-icon.png', size: 180, bleed: true, scale: 1 },
];

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 600, height: 600 } });
  for (const icon of ICONS) {
    const inner = Math.round(icon.size * icon.scale);
    const body = icon.bleed
      ? `<div style="width:${icon.size}px;height:${icon.size}px;display:grid;place-items:center;background:linear-gradient(180deg,#2c5a42 0%,#1a3a2a 100%)"><div style="width:${inner}px;height:${inner}px">${sized(svg.replace(BACKGROUND, ''))}</div></div>`
      : `<div style="width:${icon.size}px;height:${icon.size}px">${sized(svg)}</div>`;
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${body}</body></html>`);
    await page.screenshot({ path: fileURLToPath(new URL(icon.file, outDir)), clip: { x: 0, y: 0, width: icon.size, height: icon.size }, omitBackground: true });
    console.log(`render-icons: ${icon.file}`);
  }
} finally {
  await browser.close();
}
