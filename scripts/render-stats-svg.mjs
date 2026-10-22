#!/usr/bin/env node
/**
 * render-stats-svg.mjs — 从 docs/stats.json 渲染一张「每日 Star × 累计下载量」
 * 双轴折线图 SVG（带渐变填充面积、柔和配色、卡片式质感）。
 *
 *   - 左纵轴 = 累计下载量（npm）
 *   - 右纵轴 = Star 数（GitHub）
 *   - 经典折线 + 渐变面积填充 + 圆润数据点，最后一天高亮
 *
 * 输出：docs/stats.svg
 *
 * 用法：node scripts/render-stats-svg.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATS_FILE = join(ROOT, 'docs', 'stats.json');
const SVG_FILE = join(ROOT, 'docs', 'stats.svg');

// ---------- 布局 ----------
const W = 960;
const H = 430;
const PAD = { left: 78, right: 74, top: 74, bottom: 52 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

// ---------- 配色（贴合项目冷调气质） ----------
const COL_DOWNLOAD = '#0cc2b3';   // 下载量：清透青绿
const COL_STAR = '#8b5cf6';       // Star：柔紫
const COL_DOWNLOAD_BG = '#0cc2b3';
const COL_STAR_BG = '#8b5cf6';
const GRID = '#e8ebf2';
const AXIS = '#9aa3b5';
const TEXT = '#2c3344';
const SUB = '#7a8399';
const TITLE = '#171c28';
const BG_TOP = '#fbfdff';
const BG_END = '#f2f6fb';

const TICKS = 5;

function niceCeil(v) {
  if (v <= 0) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const table = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  let k = table[table.length - 1];
  for (const t of table) {
    if (t >= n - 1e-6) { k = t; break; }
  }
  const r = k * p;
  return r < v ? (k + 0.5) * p : r;
}

function niceRound(v, ticks) {
  if (v <= 0) return [0, ticks, 1];
  const step = niceCeil(v / ticks);
  let max = step * ticks;
  while (max < v) max += step;
  return [0, max, step];
}

function fmt(n) {
  if (n >= 1000) {
    const k = n / 1000;
    return (k % 1 === 0) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return `${n}`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mapX(i, n) {
  if (n <= 1) return PAD.left + PLOT_W / 2;
  return PAD.left + (PLOT_W * i) / (n - 1);
}
function yDL(v, dlTop) { return PAD.top + PLOT_H * (1 - v / dlTop); }
function yST(v, stTop) { return PAD.top + PLOT_H * (1 - v / stTop); }

/** 面积填充（折线与底边之间） */
function area(points, bottomY, gradId) {
  if (points.length < 2) return '';
  const head = `M ${points[0][0].toFixed(1)} ${bottomY.toFixed(1)} `;
  const line = points.map(([x, y]) => `L ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const tail = ` L ${points[points.length - 1][0].toFixed(1)} ${bottomY.toFixed(1)} Z`;
  return `<path d="${head + line + tail}" fill="url(#${gradId})" stroke="none"/>`;
}

function polyline(points, color, width = 3) {
  const pts = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function circles(points, color) {
  return points
    .map(([x, y], i) => {
      const last = i === points.length - 1;
      const r = last ? 4.6 : 3.2;
      const sw = last ? 2.6 : 1.8;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="#ffffff" stroke="${color}" stroke-width="${sw}"/>`;
    })
    .join('');
}

function render(series) {
  if (!series || series.length < 1) {
    throw new Error('stats.json 没有数据（series 为空）。先运行 collect-stats.mjs。');
  }

  const n = series.length;
  const dates = series.map((p) => p.date);
  const dlMax0 = Math.max(...series.map((p) => p.downloads));
  const stMax0 = Math.max(...series.map((p) => p.stars));
  const [, dlTop] = niceRound(dlMax0 * 1.05, TICKS);
  const [, stTop] = niceRound(stMax0 * 1.1, TICKS);

  const firstDate = dates[0], lastDate = dates[n - 1];
  const lastDl = series[n - 1].downloads, lastStar = series[n - 1].stars;

  // ---- 网格 + 双轴刻度 ----
  // 左轴 = Star，右轴 = 累计下载量。网格线按左轴(Star)刻度均匀划分，
  // 右轴(下载量)的值按相同像素行反解标注，保证两轴水平线对齐。
  let grid = '', stLabels = '', dlLabels = '';
  for (let t = 0; t <= TICKS; t++) {
    const sv = (stTop / TICKS) * t;
    const sy = yST(sv, stTop); // 左轴 star 刻度所在像素行
    const isZero = t === 0;
    grid += `<line x1="${PAD.left}" y1="${sy.toFixed(1)}" x2="${W - PAD.right}" y2="${sy.toFixed(1)}" stroke="${isZero ? '#d3d9e8' : GRID}" stroke-width="${isZero ? 1.2 : 1}" ${isZero ? '' : 'stroke-dasharray="3 4"'}/>`;
    // 左轴标签 = Star 值
    stLabels += `<text x="${PAD.left - 10}" y="${(sy + 3).toFixed(1)}" text-anchor="end" font-size="11" fill="${AXIS}">${fmt(Math.round(sv))}</text>`;
    // 右轴标签 = 同一像素行对应的下载量值（反解）
    const dlAtSy = dlTop * (1 - (sy - PAD.top) / PLOT_H);
    dlLabels += `<text x="${W - PAD.right + 10}" y="${(sy + 3).toFixed(1)}" text-anchor="start" font-size="11" fill="${AXIS}">${fmt(Math.round(dlAtSy))}</text>`;
  }

  // ---- X 轴（日期） ----
  const labelEvery = Math.max(1, Math.ceil(n / Math.min(n, 10)));
  let xLabels = '';
  for (let i = 0; i < n; i++) {
    if (i % labelEvery !== 0 && i !== n - 1) continue;
    const x = mapX(i, n);
    xLabels += `<text x="${x.toFixed(1)}" y="${PAD.top + PLOT_H + 20}" text-anchor="middle" font-size="11" fill="${i === n - 1 ? COL_DOWNLOAD : AXIS}" ${i === n - 1 ? 'font-weight="600"' : ''}>${dates[i].slice(5)}</text>`;
  }

  // ---- 折线 & 面积 ----
  const dlPts = [], stPts = [];
  for (let i = 0; i < n; i++) {
    const d = series[i];
    dlPts.push([mapX(i, n), yDL(d.downloads, dlTop)]);
    stPts.push([mapX(i, n), yST(d.stars, stTop)]);
  }
  const bottomY = PAD.top + PLOT_H;

  const areaDl = area(dlPts, bottomY, 'gradDl');
  const areaSt = area(stPts, bottomY, 'gradSt');

  // ---- 顶部标题区 ----
  const title = `
    <text x="${PAD.left}" y="34" font-size="19" font-weight="700" fill="${TITLE}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif">dsh-dream-skin · 每日成长曲线</text>
    <text x="${PAD.left}" y="54" font-size="12" fill="${SUB}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif">数据自动更新 · 下载量来自 npm，Star 来自 GitHub</text>`;

  // ---- 图例（右上） ----
  const lastDlFmt = fmt(lastDl), lastStarFmt = fmt(lastStar);
  const legend = `
    <g font-family="system-ui,-apple-system,'Segoe UI',sans-serif">
      <rect x="${W - PAD.right - 330}" y="22" width="330" height="46" rx="12" fill="#ffffff" fill-opacity="0.72"
        stroke="#e3e8f0" stroke-width="1"/>
      <circle cx="${W - PAD.right - 304}" cy="40" r="5" fill="${COL_DOWNLOAD}"/>
      <text x="${W - PAD.right - 290}" y="44" font-size="13" font-weight="600" fill="${TEXT}">下载量</text>
      <text x="${W - PAD.right - 224}" y="44" font-size="13" font-weight="600" fill="${COL_DOWNLOAD}">${lastDlFmt}</text>
      <circle cx="${W - PAD.right - 152}" cy="40" r="5" fill="${COL_STAR}"/>
      <text x="${W - PAD.right - 138}" y="44" font-size="13" font-weight="600" fill="${TEXT}">Star</text>
      <text x="${W - PAD.right - 100}" y="44" font-size="13" font-weight="600" fill="${COL_STAR}">${lastStarFmt}</text>
    </g>`;

  // ---- 数据截至注脚 ----
  const footnote = `
    <text x="${W - PAD.right}" y="${H - 12}" text-anchor="end" font-size="11" fill="${SUB}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif">数据截至 ${lastDate}（npm 结算有约 1 天延迟）</text>`;

  const defs = `
    <defs>
      <linearGradient id="gradDl" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${COL_DOWNLOAD_BG}" stop-opacity="0.24"/>
        <stop offset="100%" stop-color="${COL_DOWNLOAD_BG}" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="gradSt" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${COL_STAR_BG}" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="${COL_STAR_BG}" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${BG_TOP}"/>
        <stop offset="100%" stop-color="${BG_END}"/>
      </linearGradient>
    </defs>`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="dsh-dream-skin 每日 Star 与累计下载量双轴折线图">
  ${defs}
  <rect width="${W}" height="${H}" fill="url(#bgGrad)"/>
  <g font-family="system-ui,-apple-system,'Segoe UI',sans-serif">
    <text x="18" y="${PAD.top + PLOT_H / 2}" font-size="12" fill="${COL_STAR}" transform="rotate(-90 18 ${PAD.top + PLOT_H / 2})" text-anchor="middle">Star</text>
    <text x="${W - 16}" y="${PAD.top + PLOT_H / 2}" font-size="12" fill="${COL_DOWNLOAD}" transform="rotate(-90 ${W - 16} ${PAD.top + PLOT_H / 2})" text-anchor="middle">累计下载量</text>
  </g>

  ${title}
  ${legend}

  ${grid}
  <g font-family="system-ui,-apple-system,'Segoe UI',sans-serif">${stLabels}${dlLabels}</g>

  <!-- 轴线 -->
  <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${bottomY}" stroke="#cdd3e2" stroke-width="1"/>
  <line x1="${PAD.left}" y1="${bottomY}" x2="${W - PAD.right}" y2="${bottomY}" stroke="#cdd3e2" stroke-width="1"/>

  ${areaDl}
  ${areaSt}
  ${polyline(stPts, COL_STAR, 3)}
  ${circles(stPts, COL_STAR)}
  ${polyline(dlPts, COL_DOWNLOAD, 3.2)}
  ${circles(dlPts, COL_DOWNLOAD)}
  ${xLabels}
  ${footnote}
</svg>
`;
  return svg;
}

async function main() {
  const stats = JSON.parse(await readFile(STATS_FILE, 'utf8'));
  const svg = render(stats.series);
  await writeFile(SVG_FILE, svg, 'utf8');
  console.log(`[render] 已输出 ${SVG_FILE}（${stats.series.length} 天）`);
  console.log(`[render] 范围 ${stats.series[0].date} ~ ${stats.series.at(-1).date}`);
}

main().catch((err) => {
  console.error('[render] 失败:', err.message);
  process.exit(1);
});
