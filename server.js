const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_PATH = path.join(ROOT, 'data', 'statements.seed.json');
const REPORT_LOG_PATH = path.join(ROOT, 'data', 'reports.log');
const MAX_SESSION_AGE_MS = 1000 * 60 * 60 * 2;

const sessions = new Map();
const providerState = {
  openai: { available: false, lastError: null, lastSuccessAt: null },
  anthropic: { available: false, lastError: null, lastSuccessAt: null },
  google: { available: false, lastError: null, lastSuccessAt: null }
};

const providerConfigs = {
  openai: {
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4.1'
  },
  anthropic: {
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-sonnet-4-20250514'
  },
  google: {
    keyEnv: 'GOOGLE_API_KEY',
    modelEnv: 'GOOGLE_MODEL',
    defaultModel: 'gemini-2.5-pro'
  }
};

const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';
const openRouterModelEnvByProvider = {
  openai: 'OPENROUTER_OPENAI_MODEL',
  anthropic: 'OPENROUTER_ANTHROPIC_MODEL',
  google: 'OPENROUTER_GOOGLE_MODEL'
};
const openRouterDefaultModelByProvider = {
  openai: 'openai/gpt-4.1-mini',
  anthropic: 'anthropic/claude-3.7-sonnet',
  google: 'google/gemini-2.5-pro'
};

const BANNED_CONTENT_PATTERNS = [
  /\b(as an ai|language model|cannot provide|policy|disallowed)\b/i,
  /\b(slur|hate speech)\b/i
];

const SUPPORTED_LANGUAGE_CODES = new Set(['en', 'tr']);

const HUMAN_SOURCE_ALLOWLIST = new Set([
  'www.gutenberg.org',
  'gutenberg.org',
  'www.loc.gov',
  'loc.gov',
  'www.govinfo.gov',
  'govinfo.gov',
  'en.wikiquote.org',
  'tr.wikisource.org',
  'tr.wikiquote.org',
  'wikiquote.org',
  'www.archives.gov',
  'archives.gov'
]);

let seedStatements = [];
let seedLoaded = false;

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

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

function ocrNoiseScore(value) {
  const text = String(value || '');
  if (!text) return 1;
  const symbols = (text.match(/[^\p{L}\p{N}\s.,'"!?;:()\-]/gu) || []).length;
  return symbols / text.length;
}

function hasDisallowedContent(value) {
  return BANNED_CONTENT_PATTERNS.some((pattern) => pattern.test(value));
}

function isValidStatementRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (!record.id || !record.text || !record.label || !record.topic) return false;
  if (!SUPPORTED_LANGUAGE_CODES.has(record.language_code)) return false;
  if (!['ai', 'human'].includes(record.label)) return false;
  if (typeof record.difficulty !== 'number' || record.difficulty < 0 || record.difficulty > 1) return false;
  if (!record.provenance || typeof record.provenance !== 'object') return false;

  const wc = wordCount(record.text);
  if (wc < 6 || wc > 35) return false;
  if (ocrNoiseScore(record.text) > 0.08) return false;
  if (hasDisallowedContent(record.text)) return false;

  if (record.label === 'human') {
    const p = record.provenance;
    const required = [
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
    if (!required.every((key) => p[key])) return false;
    if (record.language_code === 'tr' && p.verification_status !== 'verified') return false;
    try {
      const host = new URL(p.source_url).hostname;
      if (!HUMAN_SOURCE_ALLOWLIST.has(host) && p.tier === 'tier1') return false;
    } catch (error) {
      return false;
    }
  }

  if (record.label === 'ai') {
    const p = record.provenance;
    const required = ['provider', 'model_name', 'model_api_id', 'generated_at_utc', 'prompt_recipe_id', 'params'];
    if (!required.every((key) => p[key])) return false;
  }

  return true;
}

function dedupeStatements(records) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    const key = normalizeText(rec.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

function statementLengthDelta(a, b) {
  return Math.abs(wordCount(a.text) - wordCount(b.text));
}

function similarityScore(a, b) {
  let score = 0;
  if (a.topic === b.topic) score += 2;
  score += Math.max(0, 1 - Math.abs(a.difficulty - b.difficulty));
  score += Math.max(0, 1 - statementLengthDelta(a, b) / 20);
  return score;
}

function selectBestCounterCard(target, candidates, usedIds) {
  let best = null;
  let bestScore = -Infinity;
  for (const item of candidates) {
    if (usedIds.has(item.id)) continue;
    const score = similarityScore(target, item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  if (!best) {
    for (const item of candidates) {
      const score = similarityScore(target, item);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
  }
  return best;
}

function publicSourceCard(statement) {
  const base = {
    id: statement.id,
    label: statement.label,
    language_code: statement.language_code,
    source_language: statement.source_language || statement.language_code,
    text: statement.text,
    topic: statement.topic,
    difficulty: statement.difficulty,
    style_tags: statement.style_tags || []
  };

  if (statement.label === 'ai') {
    return {
      ...base,
      provenance: {
        source_type: 'ai',
        provider: statement.provenance.provider,
        model_name: statement.provenance.model_name,
        model_api_id: statement.provenance.model_api_id,
        generated_at_utc: statement.provenance.generated_at_utc,
        prompt_recipe_id: statement.provenance.prompt_recipe_id,
        params: statement.provenance.params,
        dataset_version: statement.provenance.dataset_version || 'unknown'
      }
    };
  }

  return {
    ...base,
    provenance: {
      source_type: 'human',
      author: statement.provenance.author,
      work_title: statement.provenance.work_title,
      publication: statement.provenance.publication,
      publication_date: statement.provenance.publication_date,
      source_url: statement.provenance.source_url,
      source_locator: statement.provenance.source_locator,
      citation: statement.provenance.citation,
      license_usage_note: statement.provenance.license_usage_note,
      verification_status: statement.provenance.verification_status,
      tier: statement.provenance.tier
    }
  };
}

function pickDifficultyRange(pool, difficultyProfile) {
  if (difficultyProfile === 'easy') return pool.filter((item) => item.difficulty <= 0.5);
  if (difficultyProfile === 'hard') return pool.filter((item) => item.difficulty >= 0.55);
  return pool;
}

function chooseRoundLabelPlan(totalRounds) {
  const labels = [];
  const half = Math.floor(totalRounds / 2);
  for (let i = 0; i < half; i += 1) labels.push('ai');
  for (let i = 0; i < half; i += 1) labels.push('human');
  if (labels.length < totalRounds) labels.push(Math.random() > 0.5 ? 'ai' : 'human');
  return shuffle(labels);
}

function buildSingleRounds(pool, totalRounds, difficultyProfile) {
  const filtered = pickDifficultyRange(pool, difficultyProfile);
  const aiPool = filtered.filter((s) => s.label === 'ai');
  const humanPool = filtered.filter((s) => s.label === 'human');
  if (aiPool.length < 2 || humanPool.length < 2) {
    throw new Error('Not enough validated statements to create single rounds.');
  }

  const labelPlan = chooseRoundLabelPlan(totalRounds);
  const usedShown = new Set();
  const usedCounter = new Set();
  const rounds = [];

  for (let i = 0; i < totalRounds; i += 1) {
    const shownLabel = labelPlan[i];
    const shownPool = shownLabel === 'ai' ? aiPool : humanPool;
    const oppositePool = shownLabel === 'ai' ? humanPool : aiPool;

    const availableShown = shownPool.filter((item) => !usedShown.has(item.id));
    const shown = availableShown.length > 0 ? availableShown[Math.floor(Math.random() * availableShown.length)] : shownPool[Math.floor(Math.random() * shownPool.length)];

    const counter = selectBestCounterCard(shown, oppositePool, usedCounter);
    if (!counter) {
      throw new Error('Failed to select a counter card for a single round.');
    }

    usedShown.add(shown.id);
    usedCounter.add(counter.id);

    rounds.push({
      index: i,
      mode: 'single',
      shown_id: shown.id,
      counter_id: counter.id,
      answered: false,
      answered_correctly: null,
      player_answer: null
    });
  }

  return rounds;
}

function buildDuelRounds(pool, totalRounds, difficultyProfile) {
  const filtered = pickDifficultyRange(pool, difficultyProfile);
  const aiPool = filtered.filter((s) => s.label === 'ai');
  const humanPool = filtered.filter((s) => s.label === 'human');
  if (aiPool.length < 2 || humanPool.length < 2) {
    throw new Error('Not enough validated statements to create duel rounds.');
  }

  const usedAi = new Set();
  const usedHuman = new Set();
  const rounds = [];

  for (let i = 0; i < totalRounds; i += 1) {
    const candidateAi = aiPool.filter((x) => !usedAi.has(x.id));
    const ai = (candidateAi.length > 0 ? candidateAi : aiPool)[Math.floor(Math.random() * (candidateAi.length > 0 ? candidateAi.length : aiPool.length))];
    const human = selectBestCounterCard(ai, humanPool, usedHuman);

    if (!human) {
      throw new Error('Failed to select human pair for duel round.');
    }

    usedAi.add(ai.id);
    usedHuman.add(human.id);

    const aiOnLeft = Math.random() > 0.5;
    rounds.push({
      index: i,
      mode: 'duel',
      left_id: aiOnLeft ? ai.id : human.id,
      right_id: aiOnLeft ? human.id : ai.id,
      ai_side: aiOnLeft ? 'left' : 'right',
      answered: false,
      answered_correctly: null,
      player_answer: null
    });
  }

  return rounds;
}

function buildReveal(round, statementMap) {
  if (round.mode === 'single') {
    const shown = statementMap.get(round.shown_id);
    const counter = statementMap.get(round.counter_id);
    const aiCard = shown.label === 'ai' ? shown : counter;
    const humanCard = shown.label === 'human' ? shown : counter;
    return {
      ai_card: publicSourceCard(aiCard),
      human_card: publicSourceCard(humanCard)
    };
  }

  const left = statementMap.get(round.left_id);
  const right = statementMap.get(round.right_id);
  const aiCard = left.label === 'ai' ? left : right;
  const humanCard = left.label === 'human' ? left : right;
  return {
    ai_card: publicSourceCard(aiCard),
    human_card: publicSourceCard(humanCard)
  };
}

function sessionRoundPayload(session, roundIndex) {
  const round = session.rounds[roundIndex];
  if (!round) return null;

  if (round.mode === 'single') {
    const shown = session.statementMap.get(round.shown_id);
    return {
      session_id: session.id,
      language_code: session.languageCode,
      mode: 'single',
      round_index: roundIndex,
      round_number: roundIndex + 1,
      total_rounds: session.totalRounds,
      score: session.score,
      prompt: {
        statement: {
          id: shown.id,
          text: shown.text,
          topic: shown.topic,
          difficulty: shown.difficulty
        }
      }
    };
  }

  const left = session.statementMap.get(round.left_id);
  const right = session.statementMap.get(round.right_id);
  return {
    session_id: session.id,
    language_code: session.languageCode,
    mode: 'duel',
    round_index: roundIndex,
    round_number: roundIndex + 1,
    total_rounds: session.totalRounds,
    score: session.score,
    prompt: {
      left: {
        id: left.id,
        text: left.text,
        topic: left.topic,
        difficulty: left.difficulty
      },
      right: {
        id: right.id,
        text: right.text,
        topic: right.topic,
        difficulty: right.difficulty
      }
    }
  };
}

function providerHealthView() {
  const out = {};
  for (const [provider, cfg] of Object.entries(providerConfigs)) {
    const directConfigured = Boolean(process.env[cfg.keyEnv]);
    const openRouterConfigured = Boolean(process.env[OPENROUTER_KEY_ENV]);
    const viaOpenRouter = !directConfigured && openRouterConfigured;
    const model = viaOpenRouter
      ? (process.env[openRouterModelEnvByProvider[provider]] || openRouterDefaultModelByProvider[provider])
      : (process.env[cfg.modelEnv] || cfg.defaultModel);

    out[provider] = {
      configured: directConfigured || openRouterConfigured,
      transport: viaOpenRouter ? 'openrouter' : 'direct',
      model,
      available: directConfigured || openRouterConfigured,
      last_error: providerState[provider].lastError,
      last_success_at: providerState[provider].lastSuccessAt
    };
  }
  return out;
}

async function readJsonBody(req) {
  if (typeof req.body !== 'undefined') {
    if (req.body === null || req.body === '') return {};
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch (error) {
        throw new Error('Invalid JSON body.');
      }
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1_000_000) {
      throw new Error('Request body too large.');
    }
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('Invalid JSON body.');
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, payload, type = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': type });
  res.end(payload);
}

function parseRoute(urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  return parts;
}

function cleanupOldSessions() {
  const cutoff = Date.now() - MAX_SESSION_AGE_MS;
  for (const [sessionId, session] of sessions.entries()) {
    if (new Date(session.createdAt).getTime() < cutoff) {
      sessions.delete(sessionId);
    }
  }
}

function parseJsonArrayFromText(text) {
  if (!text) return [];
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    // fall through
  }

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function livePrompt(recipeId, topic, languageCode) {
  if (languageCode === 'tr') {
    return `Yapay zeka ve insan metni ayırt etme oyunu için 4 adet tek cümle üret.
Kurallar:
- Cümleler Türkçe olmalı.
- Birinci tekil ya da gözlemsel anlatım kullan.
- Her cümle 9 ile 24 kelime arasında olsun.
- Doğal ve ince bir üslup kullan; kurumsal tondan kaçın.
- "bir yapay zeka olarak", politika metni, madde işaretleri, hashtag ve emoji kullanma.
- Konu ipucu: ${topic}.
Sadece dizi (JSON array) döndür; her eleman bir string olsun.`;
  }

  return `Generate 4 one-sentence statements for an AI-vs-human guessing game.
Requirements:
- First-person or observational tone.
- 9 to 24 words each.
- Natural and subtle, not corporate.
- Avoid "as an AI", policy language, lists, hashtags, emojis.
- Topic hint: ${topic}.
Return ONLY a JSON array of strings.`;
}

async function generateOpenAIStatements(model, apiKey, topic, recipeId, languageCode) {
  const response = await fetchWithTimeout('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: livePrompt(recipeId, topic, languageCode),
      temperature: 0.95,
      top_p: 0.92,
      max_output_tokens: 220
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI error ${response.status}`);
  }
  const data = await response.json();
  const outputText = (data.output_text || '').trim();
  return parseJsonArrayFromText(outputText);
}

async function generateAnthropicStatements(model, apiKey, topic, recipeId, languageCode) {
  const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 220,
      temperature: 0.95,
      messages: [{ role: 'user', content: livePrompt(recipeId, topic, languageCode) }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic error ${response.status}`);
  }
  const data = await response.json();
  const text = Array.isArray(data.content)
    ? data.content.map((item) => (item && item.text ? item.text : '')).join('\n')
    : '';
  return parseJsonArrayFromText(text);
}

async function generateGoogleStatements(model, apiKey, topic, recipeId, languageCode) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.95,
        topP: 0.92,
        maxOutputTokens: 220
      },
      contents: [{ role: 'user', parts: [{ text: livePrompt(recipeId, topic, languageCode) }] }]
    })
  });

  if (!response.ok) {
    throw new Error(`Google error ${response.status}`);
  }
  const data = await response.json();
  const text = (data.candidates || [])
    .flatMap((candidate) => ((candidate.content && candidate.content.parts) || []))
    .map((part) => part.text || '')
    .join('\n');
  return parseJsonArrayFromText(text);
}

async function generateOpenRouterStatements(model, apiKey, topic, recipeId, languageCode) {
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: livePrompt(recipeId, topic, languageCode) }],
      temperature: 0.95,
      top_p: 0.92,
      max_tokens: 220
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter error ${response.status}`);
  }
  const data = await response.json();
  const text = (data.choices || [])
    .map((choice) => (choice && choice.message ? choice.message.content : ''))
    .join('\n');
  return parseJsonArrayFromText(text);
}

function coerceGeneratedStatement(provider, model, recipeId, topic, text, idx, languageCode, generationMode = 'live_api') {
  const cleanedText = String(text || '').replace(/\s+/g, ' ').trim();
  return {
    id: uid(`ai_${provider}`),
    text: cleanedText,
    label: 'ai',
    language_code: languageCode,
    source_language: languageCode,
    difficulty: 0.55 + ((idx % 5) * 0.03),
    topic,
    style_tags: ['live_generated', 'ambiguous'],
    provenance: {
      type: 'ai',
      provider,
      model_name: model,
      model_api_id: model,
      generated_at_utc: nowIso(),
      prompt_recipe_id: recipeId,
      params: {
        temperature: 0.95,
        top_p: 0.92,
        max_output_tokens: 220
      },
      dataset_version: 'live-session-v1',
      generation_mode: generationMode
    }
  };
}

async function generateLiveAIStatements(topic, languageCode) {
  const tasks = Object.keys(providerConfigs).map(async (provider) => {
    const cfg = providerConfigs[provider];
    const directKey = process.env[cfg.keyEnv];
    const openRouterKey = process.env[OPENROUTER_KEY_ENV];
    const useOpenRouter = !directKey && Boolean(openRouterKey);
    const apiKey = useOpenRouter ? openRouterKey : directKey;
    const model = useOpenRouter
      ? (process.env[openRouterModelEnvByProvider[provider]] || openRouterDefaultModelByProvider[provider])
      : (process.env[cfg.modelEnv] || cfg.defaultModel);
    const recipeId = `live_recipe_${provider}_v1`;
    const provenanceProvider = useOpenRouter ? `openrouter:${provider}` : provider;
    const generationMode = useOpenRouter ? 'live_api_openrouter' : 'live_api';

    if (!apiKey) {
      providerState[provider].available = false;
      providerState[provider].lastError = `Missing ${cfg.keyEnv} or ${OPENROUTER_KEY_ENV}`;
      return [];
    }

    try {
      let generated = [];
      if (useOpenRouter) {
        generated = await generateOpenRouterStatements(model, apiKey, topic, recipeId, languageCode);
      } else if (provider === 'openai') {
        generated = await generateOpenAIStatements(model, apiKey, topic, recipeId, languageCode);
      } else if (provider === 'anthropic') {
        generated = await generateAnthropicStatements(model, apiKey, topic, recipeId, languageCode);
      } else if (provider === 'google') {
        generated = await generateGoogleStatements(model, apiKey, topic, recipeId, languageCode);
      }

      providerState[provider].available = true;
      providerState[provider].lastError = null;
      providerState[provider].lastSuccessAt = nowIso();

      return generated
        .slice(0, 4)
        .map((line, idx) => coerceGeneratedStatement(provenanceProvider, model, recipeId, topic, line, idx, languageCode, generationMode))
        .filter((record) => isValidStatementRecord(record));
    } catch (error) {
      providerState[provider].available = false;
      providerState[provider].lastError = String(error.message || error);
      return [];
    }
  });

  const batches = await Promise.all(tasks);
  return dedupeStatements(batches.flat());
}

function filterSeedForPolicy(records, includeTier2, languageCode) {
  const valid = records.filter((item) => isValidStatementRecord(item));
  return valid.filter((item) => {
    if (item.language_code !== languageCode) return false;
    if (item.label !== 'human') return true;
    if (languageCode === 'tr') {
      return item.provenance.tier === 'tier1' && item.provenance.verification_status === 'verified';
    }
    if (includeTier2) return true;
    return item.provenance.tier === 'tier1';
  });
}

async function buildStatementPool({ includeTier2 = true, difficultyProfile = 'mixed', languageCode = 'en' }) {
  const baseline = filterSeedForPolicy(seedStatements, includeTier2, languageCode);
  const topic = difficultyProfile === 'hard'
    ? (languageCode === 'tr' ? 'belirsiz sosyal anlar' : 'ambiguous social moments')
    : (languageCode === 'tr' ? 'gundelik hayat' : 'everyday life');
  const live = await generateLiveAIStatements(topic, languageCode);

  // Use fallback AI cache if live generation returns too little content.
  const baselineAi = baseline.filter((item) => item.label === 'ai');
  const baselineHuman = baseline.filter((item) => item.label === 'human');
  const mergedAi = dedupeStatements([...live, ...baselineAi]);

  return dedupeStatements([...baselineHuman, ...mergedAi]);
}

async function createSession(options) {
  const mode = options.mode === 'duel' ? 'duel' : 'single';
  const totalRounds = Math.max(1, Math.min(Number(options.rounds) || 10, 20));
  const difficultyProfile = ['easy', 'mixed', 'hard'].includes(options.difficulty_profile)
    ? options.difficulty_profile
    : 'mixed';
  const includeTier2 = options.human_policy !== 'tier1_only';
  const rawLanguageCode = options.language_code || 'en';
  if (!SUPPORTED_LANGUAGE_CODES.has(rawLanguageCode)) {
    throw new Error('Invalid language_code. Supported values: en, tr.');
  }
  const languageCode = rawLanguageCode;

  const pool = await buildStatementPool({ includeTier2, difficultyProfile, languageCode });
  const statementMap = new Map(pool.map((item) => [item.id, item]));

  const rounds = mode === 'duel'
    ? buildDuelRounds(pool, totalRounds, difficultyProfile)
    : buildSingleRounds(pool, totalRounds, difficultyProfile);

  const session = {
    id: uid('sess'),
    createdAt: nowIso(),
    mode,
    totalRounds,
    difficultyProfile,
    includeTier2,
    languageCode,
    score: 0,
    rounds,
    statementMap
  };

  sessions.set(session.id, session);
  cleanupOldSessions();

  return {
    id: session.id,
    mode: session.mode,
    total_rounds: session.totalRounds,
    difficulty_profile: session.difficultyProfile,
    human_policy: session.includeTier2 ? 'mixed_tiered' : 'tier1_only',
    language_code: session.languageCode,
    providers: providerHealthView()
  };
}

async function handleRequest(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlPath = parsed.pathname;
  const apiPath = urlPath.startsWith('/api') ? urlPath : `/api${urlPath}`;

  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
    sendText(res, 200, html, 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && apiPath === '/api/providers/health') {
    sendJson(res, 200, { providers: providerHealthView() });
    return;
  }

  if (req.method === 'POST' && apiPath === '/api/session') {
    try {
      const body = await readJsonBody(req);
      const sessionInfo = await createSession(body || {});
      sendJson(res, 201, { session: sessionInfo });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to create session.' });
    }
    return;
  }

  if (req.method === 'POST' && apiPath === '/api/content/report') {
    try {
      const body = await readJsonBody(req);
      const report = {
        id: uid('rep'),
        created_at: nowIso(),
        session_id: body.session_id || null,
        round_index: Number.isFinite(body.round_index) ? body.round_index : null,
        statement_id: body.statement_id || null,
        reason: String(body.reason || 'unspecified').slice(0, 400)
      };
      await fs.appendFile(REPORT_LOG_PATH, `${JSON.stringify(report)}\n`, 'utf8');
      sendJson(res, 201, { ok: true, report_id: report.id });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to submit report.' });
    }
    return;
  }

  const parts = parseRoute(apiPath);
  // /api/session/:id/round/:n and /api/session/:id/round/:n/answer
  const isRoundRoute = parts.length === 5 && parts[0] === 'api' && parts[1] === 'session' && parts[3] === 'round';
  const isRoundAnswerRoute = parts.length === 6 && parts[0] === 'api' && parts[1] === 'session' && parts[3] === 'round' && parts[5] === 'answer';
  if (isRoundRoute || isRoundAnswerRoute) {
    const sessionId = parts[2];
    const roundIndex = Number(parts[4]);
    const session = sessions.get(sessionId);

    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= session.totalRounds) {
      sendJson(res, 400, { error: 'Invalid round index.' });
      return;
    }

    if (req.method === 'GET') {
      const payload = sessionRoundPayload(session, roundIndex);
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === 'POST' && (isRoundAnswerRoute || isRoundRoute)) {
      try {
        const body = await readJsonBody(req);
        const round = session.rounds[roundIndex];
        if (round.answered) {
          sendJson(res, 409, { error: 'Round already answered.' });
          return;
        }

        let isCorrect = false;
        let expected = null;

        if (round.mode === 'single') {
          const shown = session.statementMap.get(round.shown_id);
          const guess = body && (body.guess === 'ai' || body.guess === 'human') ? body.guess : null;
          if (!guess) {
            sendJson(res, 400, { error: 'Single mode answer must include guess: ai|human.' });
            return;
          }
          expected = shown.label;
          isCorrect = guess === expected;
          round.player_answer = guess;
        } else {
          const aiSide = body && (body.ai_side === 'left' || body.ai_side === 'right') ? body.ai_side : null;
          if (!aiSide) {
            sendJson(res, 400, { error: 'Duel mode answer must include ai_side: left|right.' });
            return;
          }
          expected = round.ai_side;
          isCorrect = aiSide === expected;
          round.player_answer = aiSide;
        }

        round.answered = true;
        round.answered_correctly = isCorrect;
        if (isCorrect) {
          session.score += 1;
        }

        const reveal = buildReveal(round, session.statementMap);
        sendJson(res, 200, {
          ok: true,
          language_code: session.languageCode,
          is_correct: isCorrect,
          expected,
          score: session.score,
          round_number: roundIndex + 1,
          total_rounds: session.totalRounds,
          reveal
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message || 'Failed to submit answer.' });
      }
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found.' });
}

async function loadSeed() {
  const raw = await fs.readFile(DATA_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Seed statements file must be a JSON array.');
  }
  seedStatements = dedupeStatements(parsed.filter((item) => isValidStatementRecord(item)));
  if (seedStatements.length < 20) {
    throw new Error('Seed statements are insufficient after validation.');
  }
  seedLoaded = true;
}

async function ensureSeedLoaded() {
  if (seedLoaded) return;
  await loadSeed();
}

async function main() {
  await ensureSeedLoaded();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message || 'Internal server error.' });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`AI Lie Detector v2 server running at http://${HOST}:${PORT}`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  ensureSeedLoaded,
  loadSeed,
  handleRequest,
  createSession,
  sessionRoundPayload,
  buildReveal,
  providerHealthView
};
