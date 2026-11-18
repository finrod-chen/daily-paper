#!/usr/bin/env node
// 驗證 site.config.json、data/issues/*.json 與 data/markets/*.json（零相依的 JSON Schema draft-07 子集驗證器）。
// issues / config 有任何錯誤 → exit code 1，讓 CI 失敗。markets（台股）只警告：壞檔會被 build 略過，不擋日報部署。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schema/issue.schema.json'), 'utf8'));
const marketSchema = JSON.parse(readFileSync(join(ROOT, 'schema/market.schema.json'), 'utf8'));
let root = schema; // $ref 解析的根 schema

const isRealDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
};

const formats = {
  date: isRealDate,
  'date-time': (s) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) &&
    isRealDate(s.slice(0, 10)) &&
    !Number.isNaN(Date.parse(s)),
  uri: (s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  },
};

const typeOf = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
const typeMatches = (t, v) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeOf(v) === t);

function check(sch, data, path, errors) {
  if (sch.$ref) {
    const target = sch.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], root);
    if (!target) return errors.push(`${path}: 無法解析 $ref ${sch.$ref}`);
    return check(target, data, path, errors);
  }
  if (sch.type && !typeMatches(sch.type, data)) {
    return errors.push(`${path}: 型別應為 ${sch.type}，實際為 ${typeOf(data)}`);
  }
  if (sch.enum && !sch.enum.includes(data)) errors.push(`${path}: 必須是 ${sch.enum.join(' | ')} 之一`);
  if (typeof data === 'string') {
    if (sch.minLength != null && data.trim().length < sch.minLength) errors.push(`${path}: 不可為空字串`);
    if (sch.pattern && !new RegExp(sch.pattern).test(data)) errors.push(`${path}: 不符合格式 ${sch.pattern}`);
    if (sch.format && formats[sch.format] && !formats[sch.format](data))
      errors.push(`${path}: 不是有效的 ${sch.format}（${JSON.stringify(data)}）`);
  }
  if (typeof data === 'number') {
    if (sch.minimum != null && data < sch.minimum) errors.push(`${path}: 不可小於 ${sch.minimum}`);
    if (sch.maximum != null && data > sch.maximum) errors.push(`${path}: 不可大於 ${sch.maximum}`);
  }
  if (Array.isArray(data) && sch.items) data.forEach((v, i) => check(sch.items, v, `${path}[${i}]`, errors));
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const k of sch.required ?? []) if (!(k in data)) errors.push(`${path}: 缺少必填欄位 "${k}"`);
    for (const [k, sub] of Object.entries(sch.properties ?? {})) if (k in data) check(sub, data[k], `${path}.${k}`, errors);
  }
}

const errors = [];
const warnings = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

// ---- site.config.json ----
let config;
try {
  config = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'));
  for (const k of ['name', 'url', 'timezone', 'primary_color'])
    if (typeof config[k] !== 'string' || !config[k]) fail('site.config.json', `缺少 "${k}"`);
  if (!/^#[0-9a-fA-F]{6}$/.test(config.primary_color ?? '')) fail('site.config.json', 'primary_color 需為 #rrggbb');
  if (!Array.isArray(config.sections) || !config.sections.length) fail('site.config.json', 'sections 不可為空');
  const ids = new Set();
  for (const s of config.sections ?? []) {
    if (!s.id || !s.name) fail('site.config.json', `區段需要 id 與 name：${JSON.stringify(s)}`);
    if (!/^#[0-9a-fA-F]{6}$/.test(s.color ?? '')) fail('site.config.json', `區段 ${s.id} 的 color 需為 #rrggbb`);
    if (ids.has(s.id)) fail('site.config.json', `區段 id 重複：${s.id}`);
    ids.add(s.id);
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  } catch {
    fail('site.config.json', `無效的時區：${config.timezone}`);
  }
} catch (e) {
  fail('site.config.json', `無法讀取或解析：${e.message}`);
}

// ---- data/issues ----
const dir = join(ROOT, 'data/issues');
const files = readdirSync(dir).filter((f) => !f.startsWith('.')).sort(); // .gitkeep 等隱藏檔會被忽略
const editions = new Map();
const sectionIds = new Set((config?.sections ?? []).map((s) => s.id));
let count = 0;

for (const f of files) {
  const rel = `data/issues/${f}`;
  if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) {
    fail(rel, '檔名需為 YYYY-MM-DD.json');
    continue;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  } catch (e) {
    fail(rel, `JSON 解析失敗：${e.message}`);
    continue;
  }
  count++;
  const errs = [];
  check(schema, data, '$', errs);
  errs.forEach((m) => fail(rel, m));
  if (errs.length) continue;

  if (data.date !== f.replace('.json', '')) fail(rel, `date (${data.date}) 與檔名不一致`);
  if (editions.has(data.edition)) fail(rel, `edition ${data.edition} 與 ${editions.get(data.edition)} 重複`);
  editions.set(data.edition, rel);
  const seen = new Set();
  for (const s of data.sections) {
    if (seen.has(s.id)) fail(rel, `區段 id 重複：${s.id}`);
    seen.add(s.id);
    if (config && !sectionIds.has(s.id)) warnings.push(`${rel}: 區段 "${s.id}" 不在 site.config.json，將以預設樣式附加在最後`);
  }
}

if (!count) warnings.push('data/issues: 目前沒有任何期數，網站將顯示「尚未發刊」');

// ---- data/markets（台股，選用）：錯誤只警告，build 會略過該檔 ----
const mdir = join(ROOT, 'data/markets');
let mcount = 0;
if (existsSync(mdir)) {
  root = marketSchema;
  for (const f of readdirSync(mdir).filter((x) => !x.startsWith('.')).sort()) {
    const rel = `data/markets/${f}`;
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) { warnings.push(`${rel}: 檔名需為 YYYY-MM-DD.json，略過`); continue; }
    let data;
    try { data = JSON.parse(readFileSync(join(mdir, f), 'utf8')); } catch (e) { warnings.push(`${rel}: JSON 解析失敗，略過（${e.message}）`); continue; }
    const errs = [];
    check(marketSchema, data, '$', errs);
    if (!errs.length && data.date !== f.replace('.json', '')) errs.push(`date (${data.date}) 與檔名不一致`);
    if (errs.length) { warnings.push(`${rel}: 格式不符，網站不顯示這天的台股：${errs.slice(0, 3).join('；')}`); continue; }
    mcount++;
  }
  root = schema;
}

warnings.forEach((w) => console.warn(`⚠ ${w}`));
if (errors.length) {
  console.error(`\n✖ 驗證失敗（${errors.length} 個錯誤）\n`);
  errors.forEach((e) => console.error(`  • ${e}`));
  process.exit(1);
}
console.log(`✔ 驗證通過：${count} 期、${sectionIds.size} 個區段設定、台股 ${mcount} 天`);
