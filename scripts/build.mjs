#!/usr/bin/env node
// 單一建置腳本（Node 20+，零相依）：data/issues/*.json + site.config.json → dist/
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const cfg = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'));
const BASE = cfg.url.replace(/\/+$/, '');
const TZ = cfg.timezone || 'Asia/Taipei';
const MAX_DEFAULT = cfg.max_items_per_section ?? 6;

// ---------- 語系：所有介面文字、日期格式與字型都集中在這裡 ----------
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const T = {
  lang: 'zh-Hant-TW',
  baseLang: 'zh',
  ogLocale: 'zh_TW',
  feedLang: 'zh-TW',
  fontsUrl: 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@500;700;900&display=swap',
  cssVars: '--serif:"Noto Serif TC","Source Han Serif TC","Songti TC","PMingLiU","Noto Serif CJK TC",serif;--sans:"Noto Sans TC","PingFang TC","Microsoft JhengHei","Source Han Sans TC",system-ui,-apple-system,"Segoe UI",sans-serif;--lh:1.8;--head-lh:1.3;--head-ls:0;--name-ls:.05em',
  timeMonth: 'numeric',
  longDate: (y, m, d, wd) => `${y} 年 ${m} 月 ${d} 日 星期${WEEK[wd]}`,
  monthName: (y, m) => `${y} 年 ${m} 月`,
  dayLabel: (m, d, wd) => `${m} 月 ${d} 日（${WEEK[wd]}）`,
  time: (p) => `${+p.month}/${+p.day} ${p.hour}:${p.minute}`,
  issueNo: (n) => `第 ${n} 期`,
  sep: '｜',
  paren: (s) => `（${s}）`,
  splitBrief: /(?<=[。！？])/,
  descText: (s) => s.replace(/\s+/g, ''),
  descLen: 120,
  pagerLen: 34,
  navLatest: '最新一期',
  navArchive: '往期',
  mainMenu: '主選單',
  sectionsNav: '區段導覽',
  darkMode: '深色模式',
  skip: '跳到主要內容',
  newTab: '（另開新分頁）',
  topStory: '今日頭條',
  why: '為什麼重要',
  brief: '今日導讀',
  original: '原文：',
  count: (n) => `${n} 則`,
  figFeeds: ['來源', '個'],
  figFetched: ['今天看了', '則'],
  figKept: ['留下', '則'],
  figCost: 'AI 成本',
  colophonLabel: '本期數字',
  archiveTitle: '往期索引',
  archiveLead: (n) => (n ? `共 ${n} 期，依月份分組。` : '目前還沒有任何一期。'),
  archiveDesc: (name, n) => `${name} 全部 ${n} 期的往期索引。`,
  pagerLabel: '前後期',
  prev: '← 前一期',
  next: '後一期 →',
  soonTitle: '尚未發刊',
  soonText: '第一期還在編輯中，請稍後再來。',
  nfPageTitle: '找不到頁面',
  nfDesc: '找不到你要的頁面。',
  nfTitle: '找不到這一頁',
  nfText: '這一期可能還沒發刊，或網址有誤。',
  nfHome: '回到最新一期',
  homeTitle: (name, i) => `${name}｜${i.date} 第 ${i.edition} 期：${i.headline.title}`,
  issueTitle: (name, i) => `${i.headline.title}｜${name} ${i.date} 第 ${i.edition} 期`,
  done: (n, latest) => `✔ 建置完成：${n} 期 → dist/` + (latest ? `（最新 ${latest.date} 第 ${latest.edition} 期）` : '（尚無期數，已產生占位首頁）'),
};
// ---------- 語系結束 ----------

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const write = (rel, content) => {
  const f = join(DIST, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, content);
};
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const ymdw = (date) => { const [y, m, d] = date.split('-').map(Number); return [y, m, d, new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
const longDate = (date) => T.longDate(...ymdw(date));
const dayLabel = (date) => { const [y, m, d, wd] = ymdw(date); return T.dayLabel(m, d, wd, y); };
const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: T.timeMonth, day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shortTime = (iso) => T.time(Object.fromEntries(dtf.formatToParts(new Date(iso)).map((x) => [x.type, x.value])));
const cost = (s) => {
  const c = (s.jev_cost_usd || 0) + (s.llm_cost_usd || 0);
  return `US$${c < 0.01 && c > 0 ? c.toFixed(3) : c.toFixed(2)}`;
};
const num = (n) => Number(n).toLocaleString('en-US');
const clip = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join('') + '…' : s; };
const issueUrl = (date) => `${BASE}/${date}/`;
const cls = (id) => `sec-${id.replace(/[^a-z0-9_-]/gi, '')}`;

// ---------- load ----------
const issues = readdirSync(join(ROOT, 'data/issues'))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'data/issues', f), 'utf8')))
  .sort((a, b) => (a.date < b.date ? 1 : -1)); // 新 → 舊
const latest = issues[0] ?? null; // 尚無任何期數時為 null，會產生占位首頁

// ---------- assets ----------
rmSync(DIST, { recursive: true, force: true });
const initial = Array.from(cfg.name)[0];
// og.svg 報名字級：依字寬估算（CJK 1em、其他約 0.62em），最大 150、不超出 1000px
const nameEm = Array.from(cfg.name).reduce((n, c) => n + (/[^\x00-\x7f]/.test(c) ? 1 : 0.62), 0);
const ogSize = Math.min(150, Math.floor(1000 / Math.max(nameEm, 1)));
// 報頭字級：讓報名在手機上盡量維持一行（100vw 扣掉左右留白後除以估算字寬）
const nameFit = `calc((100vw - 40px) / ${(nameEm * 1.12).toFixed(2)})`;
const secCss = cfg.sections.map((s) => `.${cls(s.id)}{--sec:${s.color}}`).join('\n');
const css = readFileSync(join(ROOT, 'src/style.css'), 'utf8') + `\n/* generated at build time */\n:root{${T.cssVars};--accent:${cfg.primary_color};--name-fit:${nameFit}}\n${secCss}\n`;
const js = readFileSync(join(ROOT, 'src/theme.js'), 'utf8');
const CSS_PATH = `/assets/style.${hash(css)}.css`;
const JS_PATH = `/assets/theme.${hash(js)}.js`;
write(CSS_PATH.slice(1), css);
write(JS_PATH.slice(1), js);

const OG_SERIF = `'Noto Serif TC','Noto Serif',Georgia,'Songti TC',PMingLiU,serif`;
write('favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#16130f"/><rect y="54" width="64" height="10" fill="${cfg.primary_color}"/><text x="32" y="44" text-anchor="middle" font-size="40" font-weight="900" font-family="Georgia,serif" fill="#f5f1e8">${esc(initial)}</text></svg>\n`);
write('og.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#f5f1e8"/><rect x="80" y="150" width="1040" height="4" fill="#16130f"/><rect x="80" y="470" width="1040" height="2" fill="#16130f"/><rect x="80" y="478" width="1040" height="1" fill="#16130f"/><rect x="80" y="110" width="56" height="4" fill="${cfg.primary_color}"/><text x="600" y="${330 + Math.round(ogSize * 0.3)}" text-anchor="middle" font-size="${ogSize}" font-weight="900" font-family="${OG_SERIF}" fill="#16130f">${esc(cfg.name)}</text><text x="600" y="536" text-anchor="middle" font-size="32" font-family="${OG_SERIF}" fill="#5f584c">${esc(cfg.tagline || '')}</text></svg>\n`);

// ---------- components ----------
const sectionDefs = (issue) => {
  const known = cfg.sections.map((s) => ({ ...s, max: s.max_items ?? MAX_DEFAULT }));
  const extra = issue.sections
    .filter((s) => !known.some((k) => k.id === s.id))
    .map((s) => ({ id: s.id, name: s.name || s.id, color: cfg.primary_color, max: MAX_DEFAULT }));
  return [...known, ...extra];
};

function meta(it) {
  const tags = (it.tags || []).map((t) => `<li>#${esc(t)}</li>`).join('');
  const time = it.published_at ? `<time datetime="${esc(it.published_at)}">${shortTime(it.published_at)}</time>` : '';
  // 原文標題只在原文語言與本站語言不同時顯示
  const orig = it.original_title && it.original_title !== it.title && (it.original_lang || T.baseLang) !== T.baseLang
    ? `<p class="orig" lang="${it.original_lang === 'zh' ? 'zh-Hant' : 'en'}">${T.original}${esc(it.original_title)}</p>` : '';
  return `<div class="meta"><a class="src" href="${esc(it.source_url)}" target="_blank" rel="noopener">${esc(it.source_name)}<span class="sr-only">${T.newTab}</span></a>${time}${tags ? `<ul class="tags">${tags}</ul>` : ''}</div>${orig}`;
}
const imgTag = (it) => it.image ? `<figure><img src="${esc(it.image)}" alt="${esc(it.image_alt || '')}" loading="lazy" referrerpolicy="no-referrer"></figure>` : '';
const titleLink = (it) => `<a href="${esc(it.source_url)}" target="_blank" rel="noopener">${esc(it.title)}<span class="sr-only">${T.newTab}</span></a>`;

function storyHtml(it) {
  return `<li class="imp-${it.importance}${it.importance >= 5 ? ' feature' : ''}"><article class="story">${imgTag(it)}<h3>${titleLink(it)}</h3><p class="sum">${esc(it.summary)}</p><p class="why"><b>${T.why}</b>${esc(it.why)}</p>${meta(it)}</article></li>`;
}

function briefHtml(brief) {
  const parts = brief.split(T.splitBrief).map((s) => s.trim()).filter(Boolean);
  const body = parts.length >= 2 && parts.length <= 5 ? `<ol>${parts.map((p) => `<li><span>${esc(p)}</span></li>`).join('')}</ol>` : `<p>${esc(brief)}</p>`;
  return `<section class="brief" aria-labelledby="brief-h"><div class="wrap"><h2 id="brief-h" class="label">${T.brief}</h2>${body}</div></section>`;
}

function issueParts(issue) {
  const h = issue.headline;
  const secs = sectionDefs(issue)
    .map((d) => {
      const src = issue.sections.find((s) => s.id === d.id);
      if (!src) return null;
      const items = src.items
        .filter((i) => i.source_url !== h.source_url) // 頭條不在區段重複出現
        .map((it, idx) => ({ it, idx }))
        .sort((a, b) => b.it.importance - a.it.importance || a.idx - b.idx)
        .slice(0, d.max)
        .map((x) => x.it);
      return items.length ? { d, items } : null;
    })
    .filter(Boolean);
  const secnav = secs.length
    ? `<nav class="secnav" aria-label="${T.sectionsNav}"><div class="wrap"><ul>${secs.map(({ d }) => `<li class="tone ${cls(d.id)}"><a href="#sec-${esc(d.id)}">${esc(d.name)}</a></li>`).join('')}</ul></div></nav>`
    : '';
  const sectionsHtml = secs
    .map(({ d, items }) => `<section class="sec tone ${cls(d.id)}" id="sec-${esc(d.id)}" aria-labelledby="h-${esc(d.id)}"><div class="wrap sec-grid"><header class="sec-head"><h2 id="h-${esc(d.id)}">${esc(d.name)}</h2><span class="count">${T.count(items.length)}</span></header><ul class="stories">${items.map(storyHtml).join('')}</ul></div></section>`)
    .join('\n');
  const main = `<article class="issue">
<section class="lead wrap" aria-labelledby="lead-h"><p class="kicker label">${T.topStory}</p><h2 id="lead-h">${titleLink(h)}</h2>${imgTag(h)}<div class="lead-body"><div><p class="dek">${esc(h.summary)}</p>${meta(h)}</div><aside class="note"><p class="label">${T.why}</p><p class="txt">${esc(h.why)}</p></aside></div></section>
${briefHtml(issue.brief)}
${sectionsHtml}
</article>`;
  return { secnav, main };
}

function footer(issue) {
  const s = issue?.stats;
  const fig = (label, value, unit) => `<div><dt>${label}</dt><dd>${value}${unit ? `<small>${unit}</small>` : ''}</dd></div>`;
  const figs = s
    ? `<dl class="figs" aria-label="${T.colophonLabel}">${fig(T.figFeeds[0], num(s.feeds), T.figFeeds[1])}${fig(T.figFetched[0], num(s.fetched), T.figFetched[1])}${fig(T.figKept[0], num(s.kept), T.figKept[1])}${fig(T.figCost, cost(s), '')}</dl>`
    : '';
  return `<footer class="colophon"><div class="wrap">${figs}<div class="credit"><p>${esc(cfg.footer_text || '')}</p><ul><li><a href="/archive/">${T.archiveTitle}</a></li><li><a href="/feed.xml">RSS</a></li></ul></div></div></footer>`;
}

const SUN = '<svg class="i-sun" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zM11 20h2v3h-2zM1 11h3v2H1zM20 11h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zM16.3 17.7l1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z"/></svg>';
const MOON = '<svg class="i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 14.5A9 9 0 0 1 9.5 3a9 9 0 1 0 11.5 11.5z"/></svg>';

function masthead({ issue, current, h1 }) {
  const tag = h1 ? 'h1' : 'p';
  const nav = [['/', T.navLatest, 'home'], ['/archive/', T.navArchive, 'archive'], ['/feed.xml', 'RSS', 'rss']]
    .map(([href, label, key]) => `<li><a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a></li>`).join('');
  const dateline = issue ? `<div class="dateline"><time datetime="${issue.date}">${longDate(issue.date)}</time><span class="no">${T.issueNo(issue.edition)}</span></div>` : '';
  return `<header class="mast${issue ? '' : ' plain'}"><div class="wrap"><div class="util"><nav aria-label="${T.mainMenu}"><ul>${nav}</ul></nav><button id="theme-toggle" class="icon-btn" type="button" aria-pressed="false" aria-label="${T.darkMode}" hidden>${SUN}${MOON}</button></div><${tag} class="nameplate"><a href="/">${esc(cfg.name)}</a></${tag}><p class="tagline">${esc(cfg.tagline || '')}</p>${dateline}</div></header>`;
}

function page({ title, description, path, canonical, body, issue, type = 'website', noindex = false }) {
  const url = BASE + (canonical ?? path);
  return `<!doctype html>
<html lang="${esc(cfg.language || T.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="issue-date" content="${esc(issue?.date ?? latest?.date ?? '')}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f1e8">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#12110f">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(url)}">`}
<link rel="alternate" type="application/rss+xml" title="${esc(cfg.name)}" href="${BASE}/feed.xml">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="${esc(cfg.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(BASE + path)}">
<meta property="og:image" content="${BASE}/og.svg">
<meta property="og:locale" content="${T.ogLocale}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${T.fontsUrl}">
<link rel="stylesheet" href="${CSS_PATH}">
<script src="${JS_PATH}"></script>
</head>
<body>
<a class="skip" href="#main">${T.skip}</a>
${body.head}
${body.nav || ''}
<main id="main">
${body.main}
</main>
${body.foot}
</body>
</html>
`;
}

// ---------- pages ----------
function issuePage(issue, idx, isHome) {
  const newer = issues[idx - 1], older = issues[idx + 1];
  const link = (is, klass, dir) => is ? `<a class="${klass}" href="/${is.date}/"><span class="dir">${dir}</span><span class="ttl">${T.issueNo(is.edition)} · ${esc(clip(is.headline.title, T.pagerLen))}</span></a>` : '';
  const pager = older || newer ? `<nav class="pager wrap" aria-label="${T.pagerLabel}"><div>${link(older, 'prev', T.prev)}${link(newer, 'next', T.next)}</div></nav>` : '';
  const { secnav, main } = issueParts(issue);
  return page({
    title: isHome ? T.homeTitle(cfg.name, issue) : T.issueTitle(cfg.name, issue),
    description: clip(T.descText(issue.brief), T.descLen),
    path: isHome ? '/' : `/${issue.date}/`,
    canonical: `/${issue.date}/`, // 首頁與固定網址內容相同，正規網址一律指向固定網址
    issue,
    type: 'article',
    body: { head: masthead({ issue, current: isHome ? 'home' : '', h1: true }), nav: secnav, main: main + pager, foot: footer(issue) },
  });
}

if (latest) write('index.html', issuePage(latest, 0, true));
else write('index.html', page({
  title: `${cfg.name}${T.sep}${cfg.tagline || ''}`, description: cfg.description || cfg.tagline || cfg.name, path: '/',
  body: { head: masthead({ current: 'home', h1: true }), main: `<div class="empty wrap"><h2 class="page-title">${T.soonTitle}</h2><p>${T.soonText}</p></div>`, foot: footer(null) },
}));
issues.forEach((is, i) => write(`${is.date}/index.html`, issuePage(is, i, false)));

// archive
const byMonth = new Map();
for (const is of issues) { const k = is.date.slice(0, 7); (byMonth.get(k) ?? byMonth.set(k, []).get(k)).push(is); }
const archiveMain = `<div class="wrap"><div class="page-head"><h1 class="page-title">${T.archiveTitle}</h1><p>${T.archiveLead(issues.length)}</p></div>${[...byMonth]
  .map(([k, list]) => { const [y, m] = k.split('-').map(Number); return `<section class="month" aria-labelledby="m-${k}"><h2 id="m-${k}" class="label">${T.monthName(y, m)}</h2><ul class="rows">${list.map((is) => `<li><a href="/${is.date}/"><span class="no">${is.edition}</span><span class="d">${dayLabel(is.date)}</span><span class="t">${esc(is.headline.title)}</span></a></li>`).join('')}</ul></section>`; })
  .join('')}</div>`;
write('archive/index.html', page({
  title: `${T.archiveTitle}${T.sep}${cfg.name}`, description: T.archiveDesc(cfg.name, issues.length), path: '/archive/',
  body: { head: masthead({ current: 'archive', h1: false }), main: archiveMain, foot: footer(latest) },
}));

// 404
write('404.html', page({
  title: `${T.nfPageTitle}${T.sep}${cfg.name}`, description: T.nfDesc, path: '/404.html', noindex: true,
  body: { head: masthead({ current: '', h1: false }), main: `<div class="empty wrap"><p class="big">404</p><h1 class="page-title">${T.nfTitle}</h1><p>${T.nfText}</p><p class="links"><a href="/">${T.nfHome}</a><a href="/archive/">${T.archiveTitle}</a></p></div>`, foot: footer(latest) },
}));

// latest.json — 公開端點：最新一期的日期、期數與網址
write('latest.json', JSON.stringify(latest ? { date: latest.date, edition: latest.edition, url: issueUrl(latest.date) } : { date: null, edition: 0, url: `${BASE}/` }) + '\n');

// feed.xml
const rfc = (iso) => new Date(iso).toUTCString();
const cd = (s) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const feedItems = issues.slice(0, 30).map((is) => {
  const html = `<p>${esc(is.brief)}</p><h2>${esc(is.headline.title)}</h2><p>${esc(is.headline.summary)}</p><ul>${is.sections.flatMap((s) => s.items).slice(0, 12).map((it) => `<li>${esc(it.title)}${T.paren(esc(it.source_name))}</li>`).join('')}</ul>`;
  return `<item><title>${esc(`${T.issueNo(is.edition)}${T.sep}${is.headline.title}`)}</title><link>${issueUrl(is.date)}</link><guid isPermaLink="true">${issueUrl(is.date)}</guid><pubDate>${rfc(is.generated_at)}</pubDate><description>${esc(is.brief)}</description><content:encoded>${cd(html)}</content:encoded></item>`;
}).join('\n');
write('feed.xml', `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>${esc(cfg.name)}</title><link>${BASE}/</link><description>${esc(cfg.description || cfg.tagline || '')}</description><language>${T.feedLang}</language><lastBuildDate>${rfc(latest ? latest.generated_at : new Date().toISOString())}</lastBuildDate><atom:link href="${BASE}/feed.xml" rel="self" type="application/rss+xml"/>
${feedItems}
</channel></rss>
`);

// sitemap / robots / _headers
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[['/', latest?.date], ['/archive/', latest?.date], ...issues.map((i) => [`/${i.date}/`, i.date])].map(([p, d]) => `<url><loc>${BASE}${p}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`);
write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${BASE}/sitemap.xml\n`);
write('_headers', `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'

/latest.json
  Cache-Control: no-store
  Access-Control-Allow-Origin: *

/feed.xml
  Cache-Control: public, max-age=300

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`);

console.log(T.done(issues.length, latest));
