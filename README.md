# sucana-labs

Reusable AI patterns and snippets from building [Sucana](https://sucana.io) — a marketing analytics platform.

---

## Pattern #1: LLM-as-Intent-Parser

**File:** [`extract-intent.ts`](./extract-intent.ts)

Use Claude Haiku as a ~$0.001 structured intent parser for conversational AI. Instead of writing regex, keyword matching, or training a custom NLP model, you send the user's message to a cheap, fast LLM and get back structured JSON — every time.

We built this for [Sucana](https://sucana.io), where users ask things like *"How's my Facebook CPL for the last 2 weeks?"* and the system needs to turn that into a database query with the right date range, platform filter, and metric.

### The Problem

In any conversational AI that talks to structured data (databases, APIs, dashboards), you face the same challenge:

**User says:** *"Show me last 30 days of Facebook spend for Campaign-X, broken down by day"*

**Your system needs:**
```json
{
  "date_start": "2026-02-06",
  "date_end": "2026-03-08",
  "platforms": ["facebook"],
  "campaigns": ["Campaign-X"],
  "metrics": ["spend"],
  "breakdown": "daily"
}
```

The traditional approaches all have problems:
- **Regex/keyword matching** — Brittle. Breaks on "past month", "últimos 30 días", "since Feb 1st"
- **Custom NLP pipeline** — Expensive to build and maintain, needs training data
- **Let the main LLM figure it out** — Works but wastes tokens and time. Your expensive Sonnet/GPT-4 call shouldn't be doing date parsing

### The Solution: A Cheap LLM as a Pre-Processor

Call Claude Haiku (or any fast, cheap model) with a structured prompt that says *"extract these fields from this message, return JSON only."* Haiku is:

- **Fast** — ~300ms per call
- **Cheap** — ~$0.001 per call (512 max output tokens)
- **Accurate** — Handles natural language, multilingual input, abbreviations, slang
- **Structured** — Returns clean JSON every time with the right prompt

The main LLM (Sonnet, GPT-4, etc.) then receives pre-filtered data instead of having to figure out the query itself.

### The Architecture

```
User message
    ↓
┌─────────────────────────┐
│  extractIntent (Haiku)  │  ← ~$0.001, ~300ms
│  "show me FB CPL last   │
│   2 weeks for Camp-X"   │
│         ↓               │
│  { date_start, date_end,│
│    platforms, campaigns, │
│    metrics, breakdown }  │
└─────────────────────────┘
    ↓
┌─────────────────────────┐
│  Database Query Layer    │  ← Uses structured intent to build SQL
│  SELECT ... WHERE ...    │
└─────────────────────────┘
    ↓
┌─────────────────────────┐
│  Main LLM (Sonnet/GPT4) │  ← Receives pre-filtered data, focuses on analysis
│  "Your CPL is $42..."   │
└─────────────────────────┘
```

### The Core Innovation: 3-Level Context Resolution

The hardest part of multi-turn conversations isn't extracting intent from a single message — it's knowing **what to carry forward** from previous messages.

Consider this conversation:

> **User:** Show me last 30 days of Facebook data
> **Assistant:** Here's your Facebook performance for the last 30 days...
> **User:** What about the adsets?
> **User:** Now show me Google instead

On message 3 (*"What about the adsets?"*), the system needs to:
- **Carry forward** "last 30 days" (user didn't change the date)
- **Carry forward** "Facebook" (user didn't change the platform)
- **Change** filter_level to "adset" (user explicitly asked)

On message 4 (*"Now show me Google instead"*), the system needs to:
- **Carry forward** "last 30 days" (still not changed)
- **Override** platform to "Google" (user explicitly changed it)
- The adset filter from message 3? That depends on context.

We solve this with a **3-level priority system**:

```
Priority 1 — Current message specifies it
  → Extract from message. Overrides everything.

Priority 2 — Conversation history established it
  → Carry forward. Don't fall back to defaults.

Priority 3 — Nothing established
  → Return null. Let the app use its own defaults.
```

**The key insight:** Each dimension resolves independently. The user might specify a date range (Priority 1) without mentioning a campaign — so dates come from the message, but campaign comes from conversation history (Priority 2) or app defaults (Priority 3).

This is all taught to Haiku via the prompt — no code logic needed.

### The Prompt

The prompt has 4 sections that work together:

**Section 1 — Context injection:**
```
Today's date: 2026-03-08
Dashboard filters currently selected by the user:
- Date range: 2026-03-01 to 2026-03-08
- Campaign: all

Recent conversation history (last 8 messages):
user: Show me last 30 days of Facebook data
assistant: Here's your Facebook performance...

Current user message: "What about the adsets?"
```

**Section 2 — Priority resolution rules:**
```
For EACH dimension, decide which context to use:

Priority 1 — Current message specifies it
→ Extract from message. Overrides everything.

Priority 2 — Conversation history established it
→ Carry forward. Do NOT fall back to defaults.

Priority 3 — No context established
→ Return null (system uses defaults).

IMPORTANT: Each dimension is independent.
```

**Section 3 — Field definitions:**
```
- date_start: ISO date (YYYY-MM-DD) or null
- platforms: ["facebook"] or ["google"], empty = all
- metrics: ["spend", "cpl", "roas", "ctr", ...]
- breakdown: "daily" | "weekly" | "monthly" | "none"
- filter_level: "campaign" | "adset" | "ad" | "any"
- filter_logic: "and" | "or"
...
```

**Section 4 — Examples for ambiguous cases:**
```
Priority 1 (override):
- "show me the last 4 days" → date_start: 4 days ago

Priority 2 (carry forward):
- Previous asked "last 30 days", current says "any patterns?" → keep dates

Priority 3 (null):
- First message, "How are my campaigns?" → date_start: null
```

The examples are critical — they teach Haiku the difference between "carry forward from conversation" vs "use app default." Without them, the model guesses wrong ~20% of the time. With them, accuracy is ~95%+.

### The Output

For a message like *"Compare my Facebook and Google CPL for last 2 weeks, by day"*:

```json
{
  "date_start": "2026-02-22",
  "date_end": "2026-03-08",
  "campaigns": [],
  "platforms": ["facebook", "google"],
  "metrics": ["cpl"],
  "comparison_type": "none",
  "query_type": "comparison",
  "breakdown": "daily",
  "filter_level": "any",
  "filter_logic": "or"
}
```

### Graceful Degradation

If Haiku fails (network error, bad JSON, rate limit), the function returns safe defaults and never blocks the main chat:

```typescript
const DEFAULT_INTENT: ExtractedIntent = {
  date_start: null,     // app uses its own default
  date_end: null,
  campaigns: [],        // no filter = show all
  platforms: [],
  metrics: [],
  comparison_type: "none",
  query_type: "general",
  breakdown: "none",
  filter_level: "any",
  filter_logic: "or",
};
```

The main LLM still gets data (with default filters) and can still answer the question — just without the precision of extracted intent. The user never sees an error.

### Usage

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { extractIntent } from "./extract-intent";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const { intent, debug } = await extractIntent(
  anthropic,
  "Show me Facebook CPL for last 2 weeks",
  [
    // previous conversation messages for context
    { role: "user", content: "How are my campaigns doing?" },
    { role: "assistant", content: "Here's an overview..." },
  ],
  {
    // current dashboard/app state (used as Priority 3 fallback)
    date_start: "2026-03-01",
    date_end: "2026-03-08",
    campaign: "all",
  }
);

// intent.date_start  → "2026-02-22"
// intent.platforms   → ["facebook"]
// intent.metrics     → ["cpl"]

// Now use intent to build your database query
const data = await queryDatabase(intent);

// Pass filtered data to your main LLM
const response = await mainLLM(userMessage, data);
```

### Adapt It To Your Domain

The pattern is generic — swap out the field definitions for your domain:

**E-commerce chatbot:**
```
- product_category: "electronics" | "clothing" | "home" | null
- price_range: { min: number, max: number } | null
- sort_by: "price" | "rating" | "newest" | "popular"
- in_stock_only: boolean
```

**Customer support bot:**
```
- issue_type: "billing" | "technical" | "account" | "general"
- urgency: "low" | "medium" | "high"
- product: string | null
- order_id: string | null
```

**Project management assistant:**
```
- project: string | null
- assignee: string | null
- status: "open" | "in_progress" | "done" | null
- date_range: { start: string, end: string } | null
- action: "list" | "create" | "update" | "summary"
```

**Calendar/scheduling bot:**
```
- action: "schedule" | "reschedule" | "cancel" | "check_availability"
- date: string | null
- time: string | null
- duration_minutes: number | null
- participants: string[]
```

**Healthcare triage bot:**
```
- symptom_category: "pain" | "respiratory" | "digestive" | "skin" | "general"
- severity: "mild" | "moderate" | "severe"
- duration: string | null
- body_part: string | null
- action: "assess" | "find_doctor" | "medication_info"
```

In each case, the 3-priority context resolution works the same way — current message overrides conversation history, which overrides app defaults.

### Why This Works Better Than Alternatives

| Approach | Handles "last 30 days"? | Handles "últimos 30 días"? | Handles "what about adsets?" (carry-forward) | Cost per call |
|---|---|---|---|---|
| Regex | With effort | Need separate rules | No | Free |
| Custom NLP | With training data | Need multilingual data | No | Free after training |
| Main LLM does it | Yes | Yes | Yes | $0.01-0.05 |
| **Haiku pre-processor** | **Yes** | **Yes** | **Yes** | **~$0.001** |

The sweet spot: LLM-level understanding at 1/10th to 1/50th the cost of using your main model, with zero training data required.

### Requirements

- `@anthropic-ai/sdk` npm package
- Anthropic API key with access to Claude Haiku

---

Built by [Vinod Sharma](https://github.com/vinodsharma10x) while building [Sucana](https://sucana.io).
