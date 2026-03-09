/**
 * extractIntent — Use Claude Haiku as a $0.001 structured intent parser
 *
 * Pattern: Natural language → Structured JSON query params
 * Model: Claude Haiku 4.5 (fast, cheap, accurate for structured extraction)
 * Cost: ~$0.001 per call (512 max tokens)
 *
 * Instead of regex or custom NLP, we use a cheap LLM to extract structured
 * intent from user messages in a conversational analytics chatbot. The key
 * innovation is the 3-level context resolution priority system that handles
 * multi-turn conversations naturally.
 *
 * Context Resolution Priority:
 *   1. Current message specifies it → extract from message (overrides all)
 *   2. Conversation history established it → carry forward
 *   3. No context → return null (let caller use defaults)
 *
 * Each dimension (date, campaign, platform, etc.) resolves independently,
 * so a user can say "show me Facebook" (Priority 1 for platform) without
 * losing the date range from a previous message (Priority 2 for dates).
 *
 * Graceful degradation: if Haiku fails (network, bad JSON, etc.), we return
 * safe defaults and never block the main chat flow.
 *
 * @author Vinod Sharma — https://github.com/vinodsharma
 * @see https://sucana.io
 */

import Anthropic from "@anthropic-ai/sdk";

// ── Types ────────────────────────────────────────────────────────────────

interface ExtractedIntent {
  /** ISO date (YYYY-MM-DD) or null if not specified */
  date_start: string | null;
  date_end: string | null;
  /** Campaign/adset/ad name filters (partial match) */
  campaigns: string[];
  /** "facebook" | "google" — empty = all platforms */
  platforms: string[];
  /** Specific metrics requested: "spend", "cpl", "roas", "ctr", etc. */
  metrics: string[];
  /** Does the user want a comparison? */
  comparison_type: "none" | "previous_period" | "specific_range" | "year_over_year";
  /** What kind of question is this? */
  query_type: "performance" | "comparison" | "anomaly" | "recommendation" | "general";
  /** Time breakdown granularity */
  breakdown: "daily" | "weekly" | "monthly" | "none";
  /** Which ad hierarchy level to filter on */
  filter_level: "campaign" | "adset" | "ad" | "any";
  /** How multiple name filters combine */
  filter_logic: "and" | "or";
}

interface DashboardFilters {
  date_start?: string;
  date_end?: string;
  campaign?: string;
}

interface ExtractIntentResult {
  intent: ExtractedIntent;
  debug: {
    prompt: string;
    raw_response: string;
    model: string;
  };
}

// ── Default intent (returned on failure — never blocks the chat) ─────────

const DEFAULT_INTENT: ExtractedIntent = {
  date_start: null,
  date_end: null,
  campaigns: [],
  platforms: [],
  metrics: [],
  comparison_type: "none",
  query_type: "general",
  breakdown: "none",
  filter_level: "any",
  filter_logic: "or",
};

// ── Main function ────────────────────────────────────────────────────────

const MODEL = "claude-haiku-4-5-20251001";

export async function extractIntent(
  anthropic: Anthropic,
  message: string,
  conversationHistory: { role: string; content: string }[],
  dashboardFilters?: DashboardFilters,
): Promise<ExtractIntentResult> {
  const today = new Date().toISOString().split("T")[0];
  const defaultStart = dashboardFilters?.date_start || null;
  const defaultEnd = dashboardFilters?.date_end || null;

  // ── The Prompt ───────────────────────────────────────────────────────
  //
  // This is where the magic happens. The prompt has 4 sections:
  //   1. Context (today's date, dashboard state, conversation history)
  //   2. Priority resolution rules (the core innovation)
  //   3. Field definitions with extraction guidance
  //   4. Examples for ambiguous cases
  //
  // The examples are critical — they teach Haiku the difference between
  // "carry forward from conversation" vs "use dashboard default".

  const prompt = `Extract the user's intent from their message. Return ONLY valid JSON, no explanation.

Today's date: ${today}
Dashboard filters currently selected by the user:
- Date range: ${defaultStart ? `${defaultStart} to ${defaultEnd}` : "last 7 days (default)"}
${dashboardFilters?.campaign ? `- Campaign: ${dashboardFilters.campaign}` : "- Campaign: all"}

Recent conversation history (use for context continuity):
${conversationHistory.slice(-8).map((m) => `${m.role}: ${m.content}`).join("\n")}

Current user message: "${message}"

## CONTEXT RESOLUTION — CRITICAL

For EACH dimension (date range, campaign, platform, adset, ad), decide which context to use by following this priority:

**Priority 1 — Current message specifies it:**
The user's current message explicitly mentions a date, campaign, platform, adset, or ad.
→ Extract it from the message. This overrides everything else.

**Priority 2 — Conversation history established it:**
A recent message in the conversation already established a specific context (e.g., user previously asked "show me last 30 days" or "how is Campaign-X doing?"), and the current message is a follow-up that does NOT change that dimension.
→ Carry forward the value from the conversation. Do NOT fall back to dashboard filters.

**Priority 3 — No context established:**
Neither the current message nor the conversation history specifies this dimension.
→ Return null (the system will use the dashboard filters as the default).

IMPORTANT: Each dimension is independent. The user might specify a date range in their message but not mention a campaign — in that case, extract the date from the message (Priority 1) but resolve campaign via conversation history (Priority 2) or dashboard (Priority 3).

## Fields to extract:

- date_start: ISO date string (YYYY-MM-DD) or null (Priority 3)
- date_end: ISO date string (YYYY-MM-DD) or null (Priority 3)
- campaigns: array of name filters (empty array = Priority 3). Look for quoted names, identifiers, or references like "the CBO campaign". These can match campaign names, adset names, or ad names depending on filter_level.
- platforms: array — only "facebook" or "google" (empty array = Priority 3 / all platforms)
- metrics: array of specific metrics — e.g. ["spend", "cpl", "roas", "ctr", "conversions", "leads", "cac", "video", "quality"] (empty if general). Use "leads" when user asks about leads, contacts, form submissions, CPL, cost per lead. Use "conversions" for conversions/purchases from ad platforms. Use "video" for video views, watch rate, hook rate, hold rate, completion rate.
- comparison_type: "previous_period" | "specific_range" | "year_over_year" | "none"
- query_type: "performance" | "comparison" | "anomaly" | "recommendation" | "general"
- breakdown: "daily" | "weekly" | "monthly" | "none". Use "daily" when user asks for "by day", "daily", "per day", "day by day". Use "weekly"/"monthly" for those breakdowns. Default "none".
- filter_level: "campaign" | "adset" | "ad" | "any". Use "adset" when user says "adsets with X". Use "ad" when user says "ads with X". Use "campaign" when user says "campaigns with X". Default "any".
- filter_logic: "and" | "or". Use "and" when user says "X and Y", "both X and Y". Use "or" when user says "X or Y". Default "or".

## Date parsing rules:

- "all time", "ever", "all data" → date_start: "2020-01-01", date_end: "${today}"
- "last N days" → compute date_start as N days before today
- "from [date]", "since [date]" → date_start: that date, date_end: "${today}"
- "[date] to [date]" → explicit range

## Examples:

Current message context overrides (Priority 1):
- "show me the last 4 days" → date_start: 4 days ago, date_end: "${today}"
- "how's my Facebook doing" → platforms: ["facebook"]
- "total spend for Campaign-X" → date_start: "2020-01-01", date_end: "${today}", campaigns: ["Campaign-X"]

Conversation carry-forward (Priority 2):
- Previous message asked about "last 30 days", current message says "any promising combinations?" → carry forward last 30 days dates
- Previous message asked about "Campaign-X", current message says "what about the adsets?" → campaigns: ["Campaign-X"]

No context → null (Priority 3):
- First message, "How are my campaigns doing?" → date_start: null, date_end: null, campaigns: [], platforms: []

Filter logic examples:
- "ESP & Marzo26" → campaigns: ["ESP", "Marzo26"], filter_logic: "and"
- "ESP or Marzo26" → campaigns: ["ESP", "Marzo26"], filter_logic: "or"
- "Enero26" → campaigns: ["Enero26"], filter_logic: "or" (single term, doesn't matter)

Return JSON only:`;

  // ── Call Haiku ──────────────────────────────────────────────────────

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const content =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Parse JSON — handle markdown code blocks if Haiku wraps the response
    let jsonStr = content.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    }

    const parsed = JSON.parse(jsonStr);

    return {
      intent: {
        date_start: parsed.date_start || null,
        date_end: parsed.date_end || null,
        campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns : [],
        platforms: Array.isArray(parsed.platforms) ? parsed.platforms : [],
        metrics: Array.isArray(parsed.metrics) ? parsed.metrics : [],
        comparison_type: parsed.comparison_type || "none",
        query_type: parsed.query_type || "general",
        breakdown: ["daily", "weekly", "monthly"].includes(parsed.breakdown)
          ? parsed.breakdown
          : "none",
        filter_level: ["campaign", "adset", "ad", "any"].includes(parsed.filter_level)
          ? parsed.filter_level
          : "any",
        filter_logic: parsed.filter_logic === "and" ? "and" : "or",
      },
      debug: { prompt, raw_response: content, model: MODEL },
    };
  } catch (error) {
    // ── Graceful fallback — never block the chat ───────────────────
    console.error("Intent extraction failed, using defaults:", error);
    return {
      intent: { ...DEFAULT_INTENT },
      debug: { prompt, raw_response: String(error), model: MODEL },
    };
  }
}
