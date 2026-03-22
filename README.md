# AI Lie Detector v2

A provenance-first AI-vs-human guessing game with two modes:
- `Single`: one statement, guess `AI` or `Human`
- `Duel`: two statements, choose which side is AI
- Full bilingual gameplay: `English` and `Türkçe`

After each answer, the game reveals both source cards:
- AI card: provider/model/prompt recipe/timestamp/params
- Human card: author/work/citation/source URL/license/tier

Sessions are language-scoped: each session runs entirely in the selected language.

## Requirements
- Node.js 18+

## Run
```bash
cd /home/asus/game-for-ai-course-project
npm start
```
Then open [http://localhost:3000](http://localhost:3000).

## Optional Live Providers
Set one or more API keys to generate live AI statements:

```bash
export OPENAI_API_KEY="..."
export ANTHROPIC_API_KEY="..."
export GOOGLE_API_KEY="..."
export OPENROUTER_API_KEY="..."

# Optional model overrides
export OPENAI_MODEL="gpt-4.1"
export ANTHROPIC_MODEL="claude-sonnet-4-20250514"
export GOOGLE_MODEL="gemini-2.5-pro"

# Optional OpenRouter model overrides (used when OPENROUTER_API_KEY is set and direct provider key is missing)
export OPENROUTER_OPENAI_MODEL="openai/gpt-4.1-mini"
export OPENROUTER_ANTHROPIC_MODEL="anthropic/claude-3.7-sonnet"
export OPENROUTER_GOOGLE_MODEL="google/gemini-2.5-pro"
```

Without keys, the app uses validated fallback AI records from the seed dataset.
With only `OPENROUTER_API_KEY`, the backend can still generate OpenAI/Claude/Gemini-family content via OpenRouter.

## Dataset Pipeline
Seed file:
- `data/statements.seed.json`

Publish validated dataset + manifest:
```bash
npm run publish:dataset
```
Output:
- `data/published/dataset.json`
- `data/published/manifest.json`

## API Endpoints
- `GET /api/providers/health`
- `POST /api/session` (supports `language_code: "en" | "tr"`)
- `GET /api/session/:id/round/:n`
- `POST /api/session/:id/round/:n/answer`
- `POST /api/content/report`

## Notes
- Human source policy supports `mixed_tiered` and `tier1_only`.
- `language_code` defaults to `en` when omitted.
- Tier 2 records are explicitly flagged in reveal metadata.
- Source reports are logged to `data/reports.log`.
