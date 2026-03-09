# sucana-labs

Reusable AI patterns and snippets from building [Sucana](https://sucana.io) — a marketing analytics platform.

## Patterns

### [extract-intent.ts](./extract-intent.ts)
Use Claude Haiku as a ~$0.001 structured intent parser for conversational AI. Converts natural language into structured JSON query parameters with a 3-level context resolution priority system for multi-turn conversations.

**Key ideas:**
- Cheap LLM (Haiku) as a structured intent extractor — no regex, no custom NLP
- 3-priority context resolution: current message > conversation history > app defaults
- Each dimension (date, campaign, platform) resolves independently
- Graceful fallback on failure — never blocks the main chat flow
