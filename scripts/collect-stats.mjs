#!/usr/bin/env node
/**
 * collect-stats.mjs — 收集 dsh-dream-skin 的每日 Star 数与下载量，写入 docs/stats.json。
 *
 * 数据来源：
 *   - downloads：npm 官方 API /downloads/range（按天增量），累加得到「累计下载量」日序列
 *   - stars：GitHub REST API /stargazers（Accept: application/vnd.github.star+json，
 *     返回每次 star 的 starred_at 时间戳），重建「每日累计 Star」日序列
 *
 * 关于 npm 下载统计的关键事实（本脚本据此设计）：
 *   npm 的 /downloads/range 是「按天增量」且结算是 T+1~T+2 滞后——
 *   最近 1~2 天（含当天）未结算的天，API 返回 downloads=0。
 *   因此本脚本「只记录到已结算的最后一天」，未结算的日子不写进 stats.json，
 *   避免把「未结算」误画成真实 0 或假的平台期。等 npm 结算后会自然补上。
 *
 * 运行方式：
 *   - node scripts/collect-stats.mjs             # 更新到今天（GitHub Actions 每日 cron 用）
 *   - GITHUB_TOKEN=... node scripts/collect-stats.mjs   # 带认证避免 GitHub 限流
 *
 * 输出：docs/stats.json —— { meta, series: [{ date, stars, downloads }] }
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATS_FILE = join(ROOT, 'docs', 'stats.json');

const OWNER = 'RevolutionLA';
const REPO = 'dsh-dream-skin';
const PACKAGE = 'dsh-dream-skin';
const RELEASE_DATE = '2026-08-15'; // npm 包创建日（回填下载量的窗口起点）

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_ACCEPT = 'application/vnd.github.star+json';

/** YYYY-MM-DD（UTC）今天 */
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function ghFetch(url) {
  const headers = { 'User-Agent': 'dsh-dream-skin-stats', 'Accept': GH_ACCEPT };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  return res;
}

/**
 * 下载量：npm range 数据（每日增量），按 date 升序。
 */
async function fetchNpmDailyDownloads(start, end) {
  const url = `https://api.npmjs.org/downloads/range/${start}:${end}/${PACKAGE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`npm ${res.status} for ${url}`);
  const json = await res.json();
  return (json.downloads || []).map((d) => ({ date: d.day, downloads: d.downloads || 0 }));
}

/**
 * Star 数：拉取全部 stargazers 的时间戳（分页），返回按日期累计。
 * 依赖 GitHub token；无 token 时返回 null（调用方决定降级）。
 */
async function fetchStarHistory() {
  const countedByDate = new Map();
  let page = 1;
  for (; ; page++) {
    let res;
    try {
      res = await ghFetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/stargazers?per_page=100&page=${page}`
      );
    } catch (e) {
      if (page === 1) {
        console.warn(`[warn] 无法获取 star 历史（${e.message}）。将降级为仅记录当前 star 数。`);
        return null;
      }
      break;
    }
    const json = await res.json();
    if (!Array.isArray(json) || json.length === 0) break;
    for (const item of json) {
      const date = (item.starred_at || '').slice(0, 10);
      if (date) countedByDate.set(date, (countedByDate.get(date) || 0) + 1);
    }
    const link = res.headers.get('link') || '';
    if (!/rel="next"/.test(link)) break;
    if (page > 12) break;
  }
  if (countedByDate.size === 0) return null;
  const dates = [...countedByDate.keys()].sort();
  let acc = 0;
  return dates.map((date) => {
    acc += countedByDate.get(date);
    return { date, stars: acc };
  });
}

async function readStats() {
  try {
    return JSON.parse(await readFile(STATS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 从 npm 逐日增量重建「累计下载量」曲线，但只保留下限为「已结算」的日期。
 * 已结算判定：downloads > 0 的最大日期设为 settledEnd；它之前所有天（含）都可信。
 * （未结算的尾端天 npm 返回 0，不写入，避免假平层/假 0。）
 * 返回 [{ date, downloads }]（累计值，date 升序）。
 */
function buildDownloadSeries(dailyDownloads) {
  // 找到一个「已结算截止日」：最后一个增量 > 0 的天。
  // 对于它之前所有天，即使某天增量真的为 0，累计不变也是正确的。
  let settledEnd = null;
  for (const r of dailyDownloads) {
    if (r.downloads > 0) settledEnd = r.date;
  }
  if (!settledEnd) {
    // 没有任何真实增量（可能包很新或数据异常），返回空。
    return [];
  }
  const series = [];
  let acc = 0;
  for (const r of dailyDownloads) {
    acc += r.downloads;
    series.push({ date: r.date, downloads: acc });
    if (r.date === settledEnd) break; // 只到已结算日
  }
  return series;
}

async function main() {
  const today = todayUTC();

  console.log(`[collect] 拉取 npm 每日下载量: ${RELEASE_DATE} ~ ${today}`);
  const dailyDownloads = await fetchNpmDailyDownloads(RELEASE_DATE, today);

  console.log('[collect] 拉取 GitHub star 历史...');
  const dailyStars = await fetchStarHistory();

  // ---- 下载量：全量重建（只到已结算日） ----
  const downloadSeries = buildDownloadSeries(dailyDownloads);

  // ---- Star：全量重建 (dailyStars 是累计序列；无则降级为空) ----
  const starSeries = dailyStars || [];

  // ---- 合并成按日期升序的 series ----
  // 以「下载曲线」的覆盖范围为骨架，star 按需合并。
  // 若某天只有 star 没有下载数据（极早），以并有字段为准；但下载仍从 RELEASE_DATE 起。
  const map = new Map();
  for (const d of starSeries) {
    map.set(d.date, { date: d.date, stars: d.stars, downloads: null });
  }
  // 用下载曲线填充 downloads（并确保每个下载日都在 map 里）
  for (const d of downloadSeries) {
    const existing = map.get(d.date);
    if (existing) {
      existing.downloads = d.downloads;
    } else {
      map.set(d.date, { date: d.date, stars: 0, downloads: d.downloads });
    }
  }
  // star 前向填充：早期下载日没 star 数据的填 0（因为发布日 star 可能确实为 0）
  const dates = [...map.keys()].sort();
  let runStar = 0;
  for (const date of dates) {
    const p = map.get(date);
    if (p.stars != null && p.stars > 0) { runStar = p.stars; continue; }
    if (p.stars == null) p.stars = 0;
    p.stars = runStar;
  }
  const series = dates
    .map((d) => map.get(d))
    .filter((p) => p.downloads != null) // 只保留有下载数据的日期（发布日之后的几何）
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const out = {
    meta: {
      owner: OWNER,
      repo: REPO,
      package: PACKAGE,
      release: RELEASE_DATE,
      generatedAt: new Date().toISOString(),
    },
    series,
  };

  await writeFile(STATS_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[collect] 已写出 ${series.length} 天数据 -> ${STATS_FILE}`);
  if (series.length) {
    console.log(
      `[collect] 最新: ${series.at(-1).date}  stars=${series.at(-1).stars}  downloads=${series.at(-1).downloads}`
    );
  } else {
    console.warn('[collect] 未生成任何数据点');
  }
}

main().catch((err) => {
  console.error('[collect] 失败:', err.message);
  process.exit(1);
});
