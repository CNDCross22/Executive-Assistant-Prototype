# Memory

How Hermes gets more useful over time — and why it never learns anything behind her back.

---

## The rule

> Nothing becomes a durable belief unless she said it, or she approved it.

An assistant that quietly develops opinions about you is unsettling, impossible to audit, and
impossible to correct when it is wrong. So there is no silent learning anywhere in this
system. Two routes in, and both end with her.

---

## Route one: she says it

```
"Never book me before 9"  →  memory_remember tool  →  saved, active, used from the next turn
```

Immediate, confidence 1.0, `source='explicit'`. She said it; that is enough.

## Route two: it notices, then asks

```
sighting 1  →  memory_signals, observed_count = 1   invisible to her, influences nothing
sighting 2  →  observed_count = 2                   still invisible
sighting 3  →  PROPOSED                             "I've noticed X. Save that?"
                                                     ↓
                              she approves  →  active, used from now on
                              she dismisses →  dismissed, never raised again
```

Three sightings (`PROPOSAL_THRESHOLD`) before she is interrupted. **Proposed entries do not
influence any answer** — they sit waiting. And once raised, a pattern is marked `promoted_at`
so she is never asked about the same thing twice.

Detection is **pure regex** in `memory/learning.ts`. No model involved, which means it costs
nothing to run on every turn and — more importantly — it cannot invent a preference she never
expressed.

---

## The six kinds of memory

| Type | What it holds | Example |
|---|---|---|
| `preference` | How she wants things done | "No meetings before 9am" |
| `person` | Facts about someone | "James is CFO at SupplyCo" |
| `working_style` | How she operates | "Prefers short replies" |
| `operational` | Rules for the assistant | "Always ask before sending" |
| `procedural` | How to do a task | "How she likes her briefing" |
| `historical` | What happened | "Board pack sent 14 Aug" |

`preference` and `operational` entries can carry a **`key`** (`workday.start`,
`confirm.sending`). Keys are unique per user among active entries, so preferences can never
contradict each other — saving a new value archives the old one rather than stacking.

---

## Retrieval

Every turn calls `recall(userId, { query: message, limit: 10 })` before the prompt is built.

Ranking is a blend, not similarity alone:

```
score = importance × 2
      + pinned        ? 6 : 0
      + subject match ? 8 : 0     -- asking about a person surfaces facts about them
      + keyword rank  × 12        -- Postgres full-text over title + content
      + used recently ? 2 : 0
```

A high-importance standing rule outranks a loosely-matching note every time. That is
deliberate: "never book before 9" should surface on any scheduling question, whether or not
the words overlap.

**No embeddings yet.** The `to_tsvector` index does keyword retrieval with no API call and
predictable behaviour. Semantic search can be layered on later by adding a `vector` column
and blending a similarity term into that score — the shape is ready for it. It was left out
because building retrieval we could not test against a real budget would have been guesswork.

---

## Where it lands in the prompt

Retrieved entries are rendered by `memoryBlock()` in `agent/prompt.ts`, ordered
`operational → preference → working_style → procedural → person → historical` — rules that
constrain everything first.

With nothing stored, the prompt says so explicitly:

> *Nothing yet. You are new to her — do not pretend otherwise, and never invent a preference.*

That matters. A model given an empty memory block will otherwise happily improvise one.

---

## Her control

Everything is visible and reversible at `/api/memory`:

| | |
|---|---|
| `GET /api/memory` | Active, proposed, dismissed, and patterns still being watched |
| `POST /api/memory` | Add something directly |
| `POST /api/memory/:id/approve` | Turn a proposal into a belief |
| `POST /api/memory/:id/dismiss` | Reject it — stays visible, never raised again |
| `PATCH /api/memory/:id` | Edit wording, importance, pin it |
| `DELETE /api/memory/:id` | Gone permanently |

The `watching` list is worth surfacing in the UI — it shows patterns at one or two sightings,
so she can see what it is *about* to ask before it asks.

---

## Tools the agent has

| Tool | Risk | Notes |
|---|---|---|
| `memory_recall` | 0 | Look up what is known |
| `memory_list` | 0 | "What do you know about me?" |
| `memory_remember` | 1 | Private, reversible, visible to her |
| `memory_forget` | **3** | Destructive and invisible — goes through approval |

`memory_forget` is rated 3 deliberately. A model deleting what it knows about her without
asking is worse than one that saves too much, because she would never find out.

---

## What it does *not* store

- No email bodies. No Microsoft content. Outlook stays the source of truth.
- No conversation transcripts as memory — conversations persist separately in
  `conversation_messages` and are not treated as beliefs.
- Nothing from an email's *contents*. Untrusted external text must never become a durable
  belief; that is a prompt-injection route straight into long-term memory.

That last one is the important one. If a hostile email could write to memory, an attacker
would only need to be believed once.

---

## Skills

`skills` (the table) mirrors the built-in skills in `agent/skills.ts`, so procedures can be
added or reworded without a deploy. Built-ins are marked `built_in = true`.

A skill is a procedure plus, ideally, a worked example — for smaller models, showing a good
answer is far more effective than describing one. Only skills matching the current message
are loaded, and only one example is included per request, because prompt length is paid for
on every iteration.

---

## Extending the learning

Add a detector to `DETECTORS` in `memory/learning.ts`:

```ts
{
  pattern: /\b(?:always|please)\s+cc\s+([\w.@-]+)/i,
  build: (m) => ({
    signalKey: `operational:cc.${m[1]}`,
    type: 'operational',
    key: 'cc.default',
    title: `Always CC ${m[1]}`,
    content: `Copy ${m[1]} on outgoing email unless told otherwise.`,
  }),
}
```

**Keep detectors narrow.** Each should map one specific phrasing to one specific belief. Broad
inference is how assistants end up confidently believing nonsense — and a wrong belief is
worse than no belief, because it silently shapes every answer that follows.
