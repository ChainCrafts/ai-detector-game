#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'data', 'statements.seed.json');
const OUT_DIR = path.join(ROOT, 'data', 'published');

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

function wordCount(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function hasRequiredHumanProvenance(record) {
  const p = record.provenance || {};
  const keys = [
    'author',
    'work_title',
    'publication_date',
    'source_url',
    'source_locator',
    'citation',
    'license_usage_note',
    'verification_status',
    'tier'
  ];
  return keys.every((k) => p[k]);
}

function hasRequiredAIProvenance(record) {
  const p = record.provenance || {};
  const keys = ['provider', 'model_name', 'model_api_id', 'generated_at_utc', 'prompt_recipe_id', 'params'];
  return keys.every((k) => p[k]);
}

function isValid(record) {
  if (!record || typeof record !== 'object') return false;
  if (!record.id || !record.text || !record.label || !record.topic || !record.language_code) return false;
  if (!['ai', 'human'].includes(record.label)) return false;
  if (!['en', 'tr'].includes(record.language_code)) return false;
  if (typeof record.difficulty !== 'number' || record.difficulty < 0 || record.difficulty > 1) return false;
  if (wordCount(record.text) < 6 || wordCount(record.text) > 35) return false;

  if (record.label === 'human') return hasRequiredHumanProvenance(record);
  return hasRequiredAIProvenance(record);
}

function dedupe(records) {
  const out = [];
  const seen = new Set();
  for (const rec of records) {
    const key = normalizeText(rec.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

async function run() {
  const raw = await fs.readFile(SOURCE, 'utf8');
  const source = JSON.parse(raw);

  const valid = source.filter(isValid);
  const deduped = dedupe(valid);

  const manifest = {
    generated_at_utc: new Date().toISOString(),
    source_file: path.relative(ROOT, SOURCE),
    total_records: deduped.length,
    ai_records: deduped.filter((x) => x.label === 'ai').length,
    human_records: deduped.filter((x) => x.label === 'human').length,
    by_language: {
      en: deduped.filter((x) => x.language_code === 'en').length,
      tr: deduped.filter((x) => x.language_code === 'tr').length
    },
    ai_by_language: {
      en: deduped.filter((x) => x.label === 'ai' && x.language_code === 'en').length,
      tr: deduped.filter((x) => x.label === 'ai' && x.language_code === 'tr').length
    },
    human_by_language: {
      en: deduped.filter((x) => x.label === 'human' && x.language_code === 'en').length,
      tr: deduped.filter((x) => x.label === 'human' && x.language_code === 'tr').length
    },
    tier1_human: deduped.filter((x) => x.label === 'human' && x.provenance.tier === 'tier1').length,
    tier2_human: deduped.filter((x) => x.label === 'human' && x.provenance.tier === 'tier2').length,
    dataset_version: `published-${new Date().toISOString().slice(0, 10)}`
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'dataset.json'), JSON.stringify(deduped, null, 2), 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(JSON.stringify(manifest, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
