# Matching Systems, From First Principles — Implementation Plan

## Goal

Turn the supplied Hinglish transcript into a six-part, self-contained browser lesson. The lessons teach the systems-design ideas behind a fast matching service without assuming finance or trading knowledge. Financial exchanges are an optional, late-stage example—not the teaching frame.

The implementation is an educational simulation only. It must not contain financial advice, platform recommendations, promotional/course material, live prices, real transaction flows, or claims about specific companies.

## Source reduction

Keep the useful technical substance and remove:

- course promotion, prices, attendance discussion, and classroom administration;
- speculative or prescriptive trading claims;
- platform-specific UI commentary and unverified anecdotes;
- repeated questions, corrections, and transcript noise.

Translate the remaining material into direct English. Start each new idea with an everyday situation, then map it to the generic system concept. An optional glossary may reveal the original exchange term after the concept is understood.

## Learning model

Use a recurring, neutral scenario: a **campus equipment exchange**. People can reserve identical shared cameras. One person offers a camera at a minimum credit amount; another offers credits up to a maximum. The service matches compatible requests fairly and safely.

This is the concept map:

| Source framing | Plain-language lesson concept | Everyday example |
| --- | --- | --- |
| exchange / market | matching service | a desk matching people who need and offer identical equipment |
| order book | waiting list of compatible requests | a two-column reservation board |
| bid / ask | maximum offer / minimum acceptable offer | “I can pay up to 40” / “I need at least 42” |
| trade / fill | completed match | camera and credits change hands |
| market / limit order | accept best available now / wait for a stated condition | “give me the first available” / “notify me only at this limit” |
| partial fill | part of a request completed | 3 of 10 cameras matched now; the rest remain waiting |
| locked balance | reserved resource | credits or camera are held while the request is live |
| maker / taker | waiting request / request that consumes a waiting offer | a standing listing vs. a person who accepts it |
| depth / spread | visible supply around the current match point | how many items are nearby and the gap between best offers |
| candle chart | time-window summary | start, end, highest, and lowest queue price in 15 minutes |

## Lesson files

Create six independently readable HTML files and a shared stylesheet/script. Each page includes a short progress rail, a one-sentence takeaway, a static explanation, an interactive visual, a short recap, and links to the adjacent lessons.

1. `01-why-matching-services-exist.html`
   - Explain central coordinator vs. a directory/front-end that only helps people reach the coordinator.
   - Introduce separate venues: the same item can have a slightly different current match value in different places.
   - Interactive: three venue boards with a movable request; show why local activity produces local values.

2. `02-the-waiting-list.html`
   - Teach supply, demand, minimum acceptable offer, maximum offer, and the two-sided waiting list.
   - Use an equipment/room-reservation board before showing the optional original terms.
   - Interactive: add cards to each side; compatible cards automatically match and leave the board.

3. `03-choose-now-or-wait.html`
   - Explain immediate requests vs. bounded requests, best available price, cancellation, partial completion, and queue priority.
   - Interactive: guided three-step simulator with clear outcomes: completed, waiting, partially completed, cancelled.

4. `04-keep-promises-safe.html`
   - Explain resource reservation, available vs. reserved balance, fees as a service cost, and why the system must prevent double-spending.
   - Interactive: a balance ledger where creating a waiting request moves a resource to “reserved,” then restores or transfers it after cancellation/match.

5. `05-one-fast-brain-and-a-durable-record.html`
   - Explain the critical path, in-memory working state, durable records, sequential matching, race conditions, locks, snapshots, and the limits of a simple first version.
   - Everyday examples: cinema-seat checkout and double-clicked payment requests.
   - Interactive: race-condition timeline with two requests reading the same balance; toggle a lock to show the correct sequence.

6. `06-history-live-updates-and-the-build-plan.html`
   - Explain intended requests vs. completion records, time-window summaries, precomputed aggregates, polling versus live updates, and a path from V1 to a scaled architecture.
   - Include an optional source-term glossary and a system-design recap.
   - Interactive: turn many event dots into one time-window summary; animate a small live update stream with a reduced-motion static mode.

## Domain schema

The lesson should expose a generic schema diagram on Lessons 5–6. Use names that describe behaviour instead of financial jargon.

```text
Participant 1 ──< Request >── 1 MatchingPool
Participant 1 ──< ResourceBalance >── 1 Resource
Request 1 ──< Completion >── 1 Participant (counterparty hidden)
Resource 1 ──< TimeWindowSummary
MatchingPool ── owns ── InMemoryWaitingList
```

### Durable records

```text
Participant
  id, displayName, credentialHash, createdAt

Resource
  id, code, name, unitScale

MatchingPool
  id, offeredResourceId, requestedResourceId, lastCompletedUnitValue

Request
  id, participantId, poolId, direction,
  executionMode, limitUnitValue?, requestedQuantity,
  completedQuantity, status, createdAt, cancelledAt?

Completion
  id, requestId, participantId, poolId,
  quantity, unitValue, role, serviceCost, completedAt

ResourceBalance
  participantId, resourceId,
  availableQuantity, reservedQuantity, updatedAt

TimeWindowSummary
  poolId, interval, windowStart,
  openingValue, highestValue, lowestValue, closingValue
```

### In-memory working state

```text
WaitingListByPool = {
  poolId: {
    requestsOffering: PriceLevel[],
    requestsSeeking: PriceLevel[],
    lastCompletedUnitValue: integer
  }
}

BalanceCache = Map<participantId, Map<resourceId, { available, reserved }>>
```

`PriceLevel` contains an integer unit value and FIFO request references. Values and quantities are stored as scaled integers—not floating-point values—so the lesson can demonstrate precision safely.

### Request lifecycle

```text
created → matching → completed
                  ↘ waiting → partially_completed → completed
                            ↘ cancelled
```

Rules to explain visually:

- A request may only use an available resource; the required amount becomes reserved before it waits.
- The matching service chooses the best compatible waiting request, then applies queue priority at the same value.
- A completion updates both participants’ balances, reservation amounts, request totals, and history together.
- A request that asks for “immediate or cancel” never remains on the waiting list.
- A request that insists on waiting is cancelled if it would complete immediately.

## API-shaped teaching contract

Use this as a diagram/copy block, not as a live service:

```text
POST   /sign-up
POST   /sign-in
POST   /requests                 create and immediately attempt a match
GET    /requests/:id             request plus its completion history
DELETE /requests/:id             cancel uncompleted remainder
GET    /pools/:code/depth        bounded two-sided waiting list
GET    /requests                 participant request history
GET    /completions              participant completion history
GET    /balances                 available and reserved resources
```

## Interaction and motion standards

- Prefer semantic HTML, CSS, and small inline SVG/vanilla JavaScript. Do **not** add Three.js: the relationships are two-dimensional and clear SVG makes them easier to inspect and accessible.
- Motion illustrates state changes only: cards move from waiting list to completed tray, a balance shifts between available/reserved, and timeline events advance one at a time.
- Never hide essential content behind animation. Every state has readable text and a static diagram.
- Respect `prefers-reduced-motion: reduce`: stop automatic movement, show final positions, and preserve all controls.
- Use buttons, not clickable divs; visible keyboard focus; labelled controls; descriptions for SVG visuals; and no reliance on red/green alone.

## File structure

```text
index.html
01-why-matching-services-exist.html
02-the-waiting-list.html
03-choose-now-or-wait.html
04-keep-promises-safe.html
05-one-fast-brain-and-a-durable-record.html
06-history-live-updates-and-the-build-plan.html
assets/styles.css
assets/lesson-shell.js
assets/interactive-diagrams.js
```

## Validation checklist

- Open every page directly in a browser; navigation and all diagrams work without a server.
- Test each interaction with mouse and keyboard.
- Verify static behaviour with reduced motion enabled.
- Check narrow mobile width, normal desktop width, headings, landmark order, contrast, and no horizontal overflow.
- Ensure no personal data, live trading capability, financial advice, or uncredited copied UI is represented.
