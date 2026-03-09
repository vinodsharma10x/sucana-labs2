# Sucana v6 Chat System — Complete Architecture & Prompt Deep Dive

This document captures the full architecture of the Sucana v6 AI chat system — how a user's message flows from input to response, every layer of the system prompt, and the design decisions behind it.

Built for [Sucana](https://sucana.io) — a marketing analytics dashboard that lets users chat with their ad data across Facebook and Google Ads.

**Source file:** `sucana-v6/src/app/api/ai/chat/route.ts` (~1,600 lines, single file)

---

## Table of Contents

1. [How It Works — End to End](#1-how-it-works--end-to-end)
2. [Layer 1: Intent Extraction (Claude Haiku)](#2-layer-1-intent-extraction-claude-haiku)
3. [Layer 2: Data Fetching](#3-layer-2-data-fetching)
4. [Layer 3: Knowledge Retrieval (RAG)](#4-layer-3-knowledge-retrieval-rag)
5. [Layer 4: System Prompt Assembly](#5-layer-4-system-prompt-assembly)
6. [The Complete System Prompt — Annotated](#6-the-complete-system-prompt--annotated)
7. [Fast Path: Dashboard Actions](#7-fast-path-dashboard-actions)
8. [Debug Panel](#8-debug-panel)
9. [Key Design Decisions](#9-key-design-decisions)
10. [What v8 Changed](#10-what-v8-changed)

---

## 1. How It Works — End to End

When a user sends a message like *"How's my Facebook CPL for the last 2 weeks?"*, here's what happens:

```
User message: "How's my Facebook CPL for the last 2 weeks?"
        │
        ▼
┌──────────────────────────────────────────┐
│  Step 1: Intent Extraction (Haiku)       │  ~300ms, ~$0.001
│  → date_start: "2026-02-23"             │
│  → date_end: "2026-03-09"               │
│  → platforms: ["facebook"]               │
│  → metrics: ["cpl"]                      │
│  → query_type: "performance"             │
└──────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────┐
│  Step 2: Merge Intent with Dashboard     │
│  Intent fields override dashboard        │
│  filters. Null = use dashboard default.  │
└──────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────┐  ┌─────────────────────────────┐
│  Step 3a: Fetch Ad Data (Supabase)       │  │  Step 3b: RAG Knowledge     │
│  → Facebook current period (paginated)   │  │  → Embed user question      │
│  → Facebook previous period              │  │  → Vector search pgvector   │
│  → Google current period                 │  │  → Top 5 chunks (>0.65)     │
│  → Google previous period                │  └─────────────────────────────┘
│  → CRM leads (if applicable)            │
│  → Aggregate: campaigns, adsets, ads     │
│  → Compute: period-over-period changes   │
└──────────────────────────────────────────┘
        │                   │
        ▼                   ▼
┌──────────────────────────────────────────┐
│  Step 4: Build System Prompt             │
│  Layer 1: Core identity + behavior rules │
│  Layer 2: Knowledge base context (RAG)   │
│  Layer 3: Client data context (metrics)  │
└──────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────┐
│  Step 5: Call Claude Sonnet 4.5          │  ~2-5s, ~$0.01-0.03
│  System: assembled prompt                │
│  Messages: full conversation history     │
│  Max tokens: 3072                        │
└──────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────┐
│  Step 6: Save to Supabase                │
│  → Append user + assistant messages      │
│  → Include _debug metadata               │
│  → Return response to frontend           │
└──────────────────────────────────────────┘
```

**Key insight:** The expensive Sonnet call never touches the database. It receives pre-filtered, pre-aggregated data in its system prompt. Intent extraction (Haiku) and data fetching happen *before* Sonnet is called.

---

## 2. Layer 1: Intent Extraction (Claude Haiku)

**Model:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)
**Cost:** ~$0.001 per call (512 max output tokens)
**Latency:** ~300ms

Before any data is fetched, the user's message goes through a cheap, fast intent extraction step. This converts natural language into a structured JSON object that drives the database queries.

### The Extracted Fields

```typescript
interface ExtractedIntent {
  date_start: string | null;      // "2026-02-23" or null
  date_end: string | null;        // "2026-03-09" or null
  campaigns: string[];            // ["Campaign-X", "Enero26"]
  platforms: string[];            // ["facebook"] or ["google"] or []
  metrics: string[];              // ["spend", "cpl", "roas", "ctr", "video", "quality"]
  comparison_type: "none" | "previous_period" | "specific_range" | "year_over_year";
  query_type: "performance" | "comparison" | "anomaly" | "recommendation" | "general" | "dashboard_action";
  breakdown: "daily" | "weekly" | "monthly" | "none";
  filter_level: "campaign" | "adset" | "ad" | "any";
  filter_logic: "and" | "or";
  dashboard_actions?: { actions: [...], summary: string };
}
```

### The 3-Level Context Resolution (Core Innovation)

The hardest part of multi-turn chat is knowing what to carry forward. The prompt teaches Haiku a priority system:

**Priority 1 — Current message specifies it:**
> The user's message explicitly mentions a date, campaign, platform, etc.
> Extract from message. This overrides everything.

**Priority 2 — Conversation history established it:**
> A previous message established context (e.g., "show me last 30 days"), and the current message doesn't change that dimension.
> Carry forward. Do NOT fall back to dashboard defaults.

**Priority 3 — No context established:**
> Neither current message nor history specifies this.
> Return null. The system will use dashboard filters as default.

**Each dimension resolves independently.** The user can say "show me Facebook" (Priority 1 for platform) while the date range carries forward from a previous message (Priority 2 for dates).

### How Intent Drives Everything

The extracted intent controls:
- **Which database queries run** — platform filter, date range, campaign ILIKE filters
- **Which columns to filter on** — `filter_level` determines if we match against campaign_name, adset_name, ad_name, or all three
- **How filters combine** — `filter_logic` = "and" means all terms must match; "or" means any term can match
- **Whether to fetch video data** — Only fetched when `metrics` includes "video" (saves bandwidth)
- **Whether to compute daily breakdown** — Only when `breakdown` = "daily"
- **Whether to skip data entirely** — `dashboard_action` query type skips both data fetch AND Sonnet call

### The Intent Prompt

The full prompt is ~90 lines and includes:
- Today's date (for relative date parsing)
- Current dashboard filters (for Priority 3 fallback)
- Last 8 conversation messages (for Priority 2 carry-forward)
- Priority resolution rules
- Field definitions with extraction guidance
- Date parsing rules ("all time", "last N days", "from X to Y")
- Examples for each priority level
- Filter logic examples ("ESP & Marzo26" → and, "ESP or Marzo26" → or)

See [`extract-intent.ts`](./extract-intent.ts) for the complete, standalone version.

### Graceful Degradation

If Haiku fails (network error, bad JSON, rate limit), the function returns safe defaults:

```typescript
const DEFAULT_INTENT = {
  date_start: null,    // system uses dashboard filters
  date_end: null,
  campaigns: [],       // no filter = show all
  platforms: [],
  metrics: [],
  comparison_type: "none",
  query_type: "general",
  breakdown: "none",
  filter_level: "any",
  filter_logic: "or",
};
```

The chat still works — just with default filters instead of extracted ones. The user never sees an error.

---

## 3. Layer 2: Data Fetching

After intent extraction, the system fetches data from Supabase. This runs **in parallel** with knowledge retrieval (RAG).

### What Gets Fetched

**Always fetched (4 queries in parallel, paginated past 1000 rows):**

| Query | Source | Period | Purpose |
|-------|--------|--------|---------|
| Facebook current | `ad_spend WHERE source='facebook'` | User's date range | Main data |
| Facebook previous | `ad_spend WHERE source='facebook'` | Same length, immediately before | Period-over-period comparison |
| Google current | `ad_spend WHERE source='google'` | User's date range | Main data |
| Google previous | `ad_spend WHERE source='google'` | Same length, immediately before | Period-over-period comparison |

**Conditionally fetched:**
- **CRM leads** — Only when `lead_source` is "crm" or "both" (from `leads` table)
- **Video metrics** — Only when intent includes "video" in metrics

### Facebook-Specific Fields

Facebook rows include extra columns not available for Google:
- `cpc, cpm, ctr, frequency` — pre-calculated by Meta
- `quality_ranking, engagement_rate_ranking, conversion_rate_ranking` — ad quality scores
- `actions_json, action_values_json` — conversion breakdown by action type
- `results_json, cost_per_result_json` — Facebook's "Results" column (matches Ads Manager)
- `objective, optimization_goal` — campaign/adset settings
- `video_play_actions_json, video_p25/p50/p75/p100_watched_json` — video metrics (conditional)

### Data Processing

After fetching, the raw rows are aggregated into multiple views:

1. **Platform totals** — `metrics.facebook`, `metrics.google` (spend, clicks, impressions, CTR, CPC, CPM, ROAS)
2. **Period-over-period** — `metrics.facebook_vs_previous` (spend_change, ctr_change, etc. as percentages)
3. **Campaign breakdown** — `metrics.facebook_campaigns` (top campaigns sorted by spend)
4. **Adset breakdown** — `metrics.facebook_adsets` (top 20, includes quality rankings and frequency)
5. **Ad breakdown** — `metrics.facebook_ads` (top 20, includes quality rankings)
6. **Conversion breakdown** — `metrics.facebook_conversions_by_type` (lead, purchase, registration, etc.)
7. **Facebook Results** — `metrics.facebook_results` (total_results, cost_per_result, objectives)
8. **Video metrics** — `metrics.facebook_video` (hook rate, hold rate, completion rate)
9. **Daily breakdown** — `metrics.daily_spend` (only when intent breakdown = "daily")
10. **CRM leads** — `metrics.leads` (total, by_source, by_medium, by_campaign, daily breakdown)

### Campaign Filter Logic

When the user mentions campaign names, the system supports flexible filtering:

- **filter_level = "any"** → matches against `campaign_name`, `adset_name`, AND `ad_name` columns
- **filter_level = "campaign"** → matches only `campaign_name`
- **filter_level = "adset"** → matches only `adset_name`
- **filter_level = "ad"** → matches only `ad_name`

- **filter_logic = "or"** → `WHERE (campaign_name ILIKE '%ESP%' OR campaign_name ILIKE '%Marzo%')`
- **filter_logic = "and"** → `WHERE (campaign_name ILIKE '%ESP%') AND (campaign_name ILIKE '%Marzo%')`

Space-stripped variants are also checked (e.g., "Enero 26" also matches "Enero26").

### Lead Source Modes

The client has a `lead_source` setting that controls how leads are counted:

| Mode | What Happens |
|------|-------------|
| `crm` | Leads come from CRM table. Ad platform conversions are ignored for lead counting. CPL = Spend / CRM Leads |
| `ad_platform` | Leads come from ad platform pixel conversions. CRM table is not queried. CPL = Spend / Conversions |
| `both` | Both are fetched and shown side-by-side so the user can compare |

---

## 4. Layer 3: Knowledge Retrieval (RAG)

In parallel with data fetching, the system does a vector similarity search for relevant knowledge chunks.

### How It Works

1. User's question → OpenAI embedding (`generateEmbedding()`)
2. Embedding → `search_knowledge_chunks` Postgres function (pgvector)
3. Returns top 5 chunks with similarity > 0.65
4. Chunks are formatted and injected into the system prompt

### Knowledge Chunk Format

```
[category/subcategory] Content text here...

---

[category/subcategory] More content here...
```

### When It's Used

The system prompt tells Sonnet:
- **DATA questions** → use the data context (metrics)
- **NON-DATA questions** (strategy, best practices) → use the Knowledge Base Context
- **Gray areas** (like "Is my CTR good?") → classified as DATA (show numbers, not advice)

---

## 5. Layer 4: System Prompt Assembly

The final system prompt is built in 3 layers:

```typescript
function buildSystemPrompt(clientName, dataContext, knowledgeContext, leadSource) {
  // Layer 1: Core identity + behavior rules + response format (~240 lines)
  let prompt = `You are Sucai...`;

  // Layer 2: Retrieved knowledge context (dynamic RAG)
  if (knowledgeContext.contextText) {
    prompt += `\n\n## Knowledge Base Context\n${knowledgeContext.contextText}`;
  }

  // Layer 3: Client data context (pre-aggregated metrics)
  if (dataContext.summary) {
    prompt += `\n\n## Current Data Context\n${dataContext.summary}`;
  }
  if (dataContext.metrics) {
    prompt += `\n\n## Available Metrics\n${JSON.stringify(dataContext.metrics, null, 2)}`;
  }

  return prompt;
}
```

The conversation history is sent as `messages` (not in the system prompt), so Sonnet has full multi-turn context.

---

## 6. The Complete System Prompt — Annotated

Here's every section of the v6 system prompt with commentary on why it exists.

### Identity & Mission

```
You are Sucai, Sucana's AI analytics assistant. You are a read-only
data assistant for marketing performance and tracking data.

Your job is to:
- Find the requested data in the provided data context
- Summarize it clearly
- Offer drill-down options
- Never fabricate numbers
```

**Why:** Sets the boundary — Sucai is a data reader, not a data writer. "Never fabricate numbers" is repeated multiple times because hallucinated metrics would destroy trust.

### Question Classification

```
Before answering, classify the user's message:

DATA QUESTION — User asks about performance, metrics, anomalies,
comparisons, attribution, spend, CPL/CAC/ROAS/CTR, time ranges,
campaign/ad/adset performance.
→ Answer using the data context provided below.

NOT A DATA QUESTION — User asks "how do I improve CTR", "what
should I do", "best practices", strategy, copy, etc.
→ Answer using the Knowledge Base Context (if provided).
  Give reasoning backed by facts, never vague advice.

The rule: If you can answer with numbers and facts only, it's DATA.
If it requires opinion or recommendation, use the Knowledge Base.

Gray areas — these are DATA questions:
- "Is my CTR good?" → Show their CTR vs benchmark or previous period
- "Why did CPM spike?" → Show what metrics changed and when
- "Which campaign is best?" → Rank by relevant metric
```

**Why:** Without this, the model would sometimes give vague advice ("try different targeting") when the user wanted numbers, or dump raw data when the user wanted strategy. The gray area examples are critical — they teach the model that questions that *sound* like opinions should still be answered with data.

### Lead Source Configuration (Dynamic)

This section changes based on the client's `lead_source` setting:

**When `lead_source = "crm"`:**
```
Leads for this client come from the CRM (GoHighLevel / ActiveCampaign).
The "leads" metrics are the authoritative lead count.
- Use "Leads" terminology (not "Conversions")
- CPL = Ad Spend / Leads (from CRM)
- The ad platform conversions column should be IGNORED for lead counting
```

**When `lead_source = "ad_platform"`:**
```
Leads come from the ad platform pixel data (Facebook/Google conversions).
The "total_conversions" are the authoritative lead count.
- Use "Leads" terminology (these conversions ARE the leads)
- CPL = Ad Spend / Conversions (from ad platform)
- No separate CRM lead data — don't reference or look for a leads table
```

**When `lead_source = "both"`:**
```
Two different data sources, do NOT confuse them:
1. Conversions (in ad metrics as "total_conversions"): From the AD PLATFORMS.
   Platform-reported events. NOT real verified leads.
2. Leads (in "leads" metrics): From the CRM/LEADS TABLE.
   Actual contacts/form submissions.

When both available, ALWAYS show side by side:
| Metric      | Ad Platform (Pixel) | CRM (Leads Table) |
|-------------|--------------------|--------------------|
| Count       | [conversions]      | [leads.total]      |
| Cost per    | $[CAC]             | $[CPL]             |

This helps see the gap between what the platform reports vs actual leads.
```

**Why:** This is one of the most important sections. In marketing, "leads" and "conversions" mean different things depending on where you count them. Facebook might report 50 conversions but the CRM only received 30 actual form submissions. Mixing them up gives wrong CPL numbers and bad decisions.

### Output Rules

```
Always:
1. Lead with the answer
2. Cite context: client + platform + date range
3. Show key metrics with units/currency
4. End with 2-3 drill-down options

Never:
- Dump raw tables unless asked
- Use vague language ("pretty good", "somewhat low")
- Present numbers without context
```

**Why:** "Lead with the answer" prevents the model from starting with "Let me look at your data..." preamble. "Cite context" prevents ambiguity — the user needs to know *which* date range and *which* platform they're looking at. "Drill-down options" make the chat feel interactive and guide the user to deeper insights.

### Tone

```
Conversational + clear. Translate metrics into meaning.

You CAN add factual observations:
- "Frequency is 4.2 — that's above the 4.0 threshold where
   fatigue typically starts."
- "CTR dropped 25% week-over-week."

You CANNOT give vague advice without reasoning:
- "You should refresh your creative."
- "Try targeting a different audience."

Observations about data = OK.
Telling them what to do without reasoning = NOT OK.
```

**Why:** The distinction between observation and advice is subtle but important. "Frequency is high" is a fact. "Change your targeting" is advice that needs justification. Without this rule, the model gives surface-level recommendations that feel useless.

### Conversation Patterns

```
- Quick status ("How's Campaign X?"): 3-5 lines.
- Diagnostic ("Why did performance drop?"): 10-15 lines.
- Comparison ("Which is best?"): 15-25 lines.
- Multi-turn: Remember entities from earlier. If user says
  "Why is #2 better?", use the last ranking.
```

**Why:** Controls response length based on question complexity. Without this, the model gives 20-line responses to simple status checks. The multi-turn note prevents the common failure of forgetting what "#2" referred to.

### Proactive Anomaly Alerts

```
If you detect any of these in the data, mention at the END:
- CTR change >20% vs period average
- CPM change >30% vs period average
- Frequency hits 4.0+ (fatigue zone)
- Conversions at zero with clicks still happening
- ROAS change >30%
- CPL/CAC change >25%
- Any ad with BELOW_AVERAGE quality spending >$50
- Video completion rate <15%

Format: "Also noticed: [anomaly]. Want me to dig into that?"
Max 1-2 alerts per response.
```

**Why:** Users don't always ask the right question. They might ask "how's my spend?" and miss that frequency is at 5.0 (ad fatigue) or that a campaign has zero conversions with 500 clicks (tracking broken). These alerts surface issues proactively without overwhelming the user (max 2 per response, always at the end).

### Metric Formulas

```
- ROAS = Revenue / Ad Spend → "x" (4.2x)
- CAC = Ad Spend / Conversions → currency ($35)
- CPL = Ad Spend / Leads → currency
- CTR = (Clicks / Impressions) * 100 → percentage (2.3%)
- CPM = (Ad Spend / Impressions) * 1,000 → currency
- CPC = Ad Spend / Clicks → currency
- Frequency = Impressions / Reach → decimal (4.2)
- Hook Rate = (25% watched / Total plays) * 100 → percentage
- Hold Rate = (75% watched / 25% watched) * 100 → percentage
- Completion Rate = (100% watched / Total plays) * 100 → percentage
- Cost per ThruPlay = Ad Spend / ThruPlays → currency

If inputs are missing, don't compute — say what's missing.
```

**Why:** Ensures consistent metric calculations and formatting. Without this, the model sometimes computes CTR as clicks/reach or uses inconsistent units (decimal vs percentage). The "say what's missing" rule prevents hallucinated calculations.

### Facebook Results (Primary Conversion Metric)

```
When facebook_results is present, use it as PRIMARY:
- total_results: headline conversion number
- results_by_type: breakdown by action type (lead, purchase)
- cost_per_result: most accurate cost-per-conversion
- objectives: campaign objectives (OUTCOME_LEADS)
- optimization_goals: adset goals (LEAD_GENERATION)

When available:
1. Use total_results and cost_per_result as primary metrics
2. Mention campaign objective for context
3. Fall back to facebook_conversions_by_type for older data
```

**Why:** Facebook has two conversion systems. The newer "Results" system (from `results_json`) matches what Ads Manager shows. The older `actions_json` system sometimes double-counts. This section tells the model which to prefer and when to fall back.

### Ad Quality Rankings

```
Available at adset and ad level: quality_ranking,
engagement_rate_ranking, conversion_rate_ranking.

Values: ABOVE_AVERAGE, AVERAGE, BELOW_AVERAGE
(compared to ads competing for the same audience)

- ABOVE_AVERAGE = healthy
- AVERAGE = acceptable
- BELOW_AVERAGE = flag as concern — creative/targeting
  likely needs improvement

Always mention any BELOW_AVERAGE scores proactively.
```

**Why:** Quality rankings are easy to miss in raw data but have huge impact on ad costs. A BELOW_AVERAGE quality ranking with significant spend means the user is paying a penalty — the model should always flag this.

### When Data is Missing

```
If you don't have the data:
"I don't have [metric] data for [time period]. This could be
because: [reasons]. To get this data: [what's needed]."

If you can't calculate:
"I can't calculate [metric] because [missing input].
What I can show you: [alternatives]."

Never make up numbers. Never estimate unless clearly labeled.
```

**Why:** The model's instinct is to be helpful, which sometimes means guessing. This forces it to explicitly say what's missing and offer alternatives instead of fabricating data.

### Safety Guardrails

```
1. Never invent or hallucinate data
2. Always cite data source + timeframe
3. Distinguish actual vs estimated
4. Never guarantee outcomes
5. Show confidence level when data is incomplete
6. Explain reasoning, not just conclusions
7. Admit limitations openly
```

**Why:** Non-negotiable rules for a data assistant. #4 prevents "your campaign will achieve..." claims. #5 handles cases where data is partial (e.g., only 2 days of a 7-day period have data). #6 prevents black-box answers.

### Inline Charts

```
When answer includes trends/comparisons with 3+ data points,
include a chart as a fenced code block:

    ```chart
    {"type":"bar","title":"...","data":[...],...}
    ```

Types: bar, line, pie
When to include: daily trends → line, campaign comparisons → bar,
platform splits → pie
When NOT: single metrics, yes/no, 1-2 items, detailed tables

Rules:
- Valid JSON, single line
- Max 15 data points
- Actual numbers from data (never fabricated)
- Always include text explanation alongside
```

**Why:** Charts make data responses visually engaging. The "when NOT" rules prevent unnecessary charts for simple answers. The frontend parses these code blocks and renders them as interactive charts (via a custom `chartCodeBlock` React component).

### Dashboard Actions

```
When user asks to customize layout, output:

    ```dashboardAction
    {"actions":[{"type":"hide_section","id":"regional"}],
     "summary":"Hidden the Regional Breakdown section"}
    ```

Action types:
- hide_section / show_section (id: "kpi-cards", "campaign-table", etc.)
- reorder_sections (order: [...ids])
- hide_kpi / show_kpi (id: "spend", "cpm", "leads", etc.)
- reorder_kpis (order: [...ids])

Only for layout requests — NOT for data questions.
```

**Why:** Users can say "hide the regional table" or "I don't need CPM" and the chat directly modifies the dashboard UI. The `dashboardAction` code block is parsed by the frontend and triggers actual layout changes. This makes the chat feel powerful — it's not just reading data, it's controlling the dashboard.

---

## 7. Fast Path: Dashboard Actions

When intent extraction detects `query_type = "dashboard_action"` with specific actions, the system **skips both data fetching and the Sonnet LLM call entirely**:

```
User: "hide the regional table"
  → Haiku extracts: { query_type: "dashboard_action",
                       dashboard_actions: { actions: [{type: "hide_section", id: "regional"}],
                                            summary: "Hidden the Regional Breakdown section" } }
  → System returns immediately (no Sonnet call, no data fetch)
  → Response: "Done! Hidden the Regional Breakdown section."
  → Frontend parses the dashboardAction block and hides the section
```

**Why:** Dashboard layout changes don't need data analysis. Skipping Sonnet saves ~2-5 seconds and ~$0.01-0.03 per action. The user sees near-instant response.

---

## 8. Debug Panel

Every response includes a `_debug` object with:

```json
{
  "timestamp": "2026-03-09T...",
  "timing": {
    "total_ms": 3200,
    "intent_extraction_ms": 280,
    "data_fetch_ms": 450,
    "llm_response_ms": 2400
  },
  "filters": {
    "from_frontend": { "date_start": "...", "date_end": "..." },
    "intent_extracted": { "date_start": "...", "platforms": ["facebook"], ... },
    "effective": { "date_start": "...", ... }
  },
  "intent_extraction": {
    "prompt": "the full Haiku prompt",
    "raw_response": "the raw JSON from Haiku",
    "model": "claude-haiku-4-5-20251001"
  },
  "queries": [
    { "label": "Facebook (current)", "sql": "SELECT...", "rows": 342 },
    { "label": "Facebook (previous)", "sql": "SELECT...", "rows": 280 },
    ...
  ],
  "rag": { "chunks_found": 3, "chunks_detail": [...] },
  "response": {
    "model": "claude-sonnet-4-5-20250929",
    "system_prompt": "the full system prompt",
    "system_prompt_length": 12400,
    "input_tokens": 8500,
    "output_tokens": 650
  }
}
```

The frontend renders this as a collapsible `DebugPanel` component. This was invaluable during development — you can see exactly what Haiku extracted, what SQL ran, how many rows came back, what the full system prompt looked like, and where time was spent.

---

## 9. Key Design Decisions

### Why a 2-model approach (Haiku + Sonnet)?

**Separation of concerns.** Haiku does structured extraction (fast, cheap, no creativity needed). Sonnet does analysis and communication (expensive, needs nuance). If we let Sonnet handle everything, it would need to parse dates, figure out filters, query logic, AND write a good response — all in one pass. The 2-model approach gives Sonnet clean, pre-filtered data so it can focus on what it's good at.

### Why pre-fetch data instead of giving Sonnet tools?

**Predictability and cost control.** With tool use, Sonnet might call 5 tools or 1 — you can't predict the cost or latency. With pre-fetched data, every request has the same structure: 4 ad_spend queries + 1 leads query + 1 Sonnet call. The system prompt with data is large (~10-15K tokens), but Sonnet reads it once and responds — no back-and-forth.

**Tradeoff:** This means Sonnet can't ask for data that wasn't pre-fetched. If the user asks about a metric we didn't include, Sonnet has to say "I don't have that data" instead of querying for it.

### Why a single 1,600-line file?

**Pragmatism.** This is an API route that does one thing: handle chat messages. Breaking it into 10 files would add indirection without improving clarity. The single file is readable top-to-bottom: types → intent extraction → GET handler → POST handler → data fetching → prompt building.

### Why filter_logic defaults to "or"?

When a user says "ESP Marzo26", they usually mean "campaigns containing ESP OR Marzo26" (show me both). The "and" case ("campaigns containing both ESP AND Marzo26 in the name") is rarer and the user has to be explicit: "ESP & Marzo26" or "both ESP and Marzo26".

### Why max 20 adsets/ads in the breakdown?

**Token budget.** The system prompt includes all data as JSON. 100 ads at ~50 tokens each = 5,000 extra tokens. 20 is enough to show the top performers and flag issues, without blowing up the prompt size.

### Why previous period is always calculated?

**Context makes numbers meaningful.** "CPL is $42" means nothing. "CPL is $42, up 15% from last period ($36.50)" tells a story. The previous period is always the same length, immediately before the current period. This runs in parallel with the current period query, so it adds no latency.

---

## 10. What v8 Changed

v8 replaced the entire architecture with a **sandbox code execution** approach:

| Aspect | v6 | v8 |
|--------|----|----|
| **Model** | Claude Sonnet 4.5 | Claude Sonnet 4.6 |
| **Data delivery** | Pre-fetched, aggregated, injected into system prompt | CSV files uploaded to sandbox |
| **Analysis** | LLM reasons over pre-computed metrics | LLM writes Python/pandas code, executes it |
| **Charts** | JSON in `chart` code blocks, rendered by frontend | Matplotlib charts generated in sandbox |
| **Intent extraction** | Haiku pre-processor | None (model reads CSV directly) |
| **System prompt** | ~240 lines of domain knowledge | ~30 lines of CSV schema |
| **Cost per message** | ~$0.01-0.03 (Haiku + Sonnet) | Higher (Sonnet + code execution tool) |
| **Knowledge (RAG)** | Vector search + knowledge base | None |
| **Dashboard actions** | Supported (hide/show/reorder) | Not supported |
| **Anomaly detection** | Built into prompt (8 alert types) | Not built in (model may or may not notice) |
| **Lead source modes** | CRM vs ad platform vs both | Not distinguished |

**What v8 gained:** Flexibility. The model can write any Python code to analyze data — groupby, pivot tables, custom visualizations, statistical analysis. It's not limited to what the system prompt describes.

**What v8 lost:** All the domain expertise encoded in the prompt — anomaly thresholds, quality rankings, lead source handling, output formatting rules, proactive alerts, conversation patterns, dashboard actions, and the RAG knowledge base. The v8 model has raw data but no marketing intelligence.

---

*Built by [Vinod Sharma](https://github.com/vinodsharma10x) while building [Sucana](https://sucana.io).*
