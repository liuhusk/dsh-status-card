# Verification status

What has actually been checked, on which host, and what is still unverified. Test suites are part of the
repository: `npm test` (103 smoke assertions) and `npm run test:mutate` (103 mutations; each mutant re-runs only the cases
it is expected to break, via `SC_ONLY`, in an 8-way parallel pool — the control run is always full).

Host used for the live checks: DSH 0.2.1-rc.3, Web UI served on `http://127.0.0.1:3080`, installed into the
`web` profile with a `link:` to the working copy, macOS, light and dark themes.

## Automated

- Static checks: `node --check` on both halves, `package.json` / locale JSON parse, zh/en locale key sets
  identical, every manifest reference (`icon`, `exports`, `dsh.bundle.patch`, `files`) resolves,
  `client.js` has no top-level `export` (it is loaded through `window.__ModuleLoader__`).
- Smoke, 103 assertions with a stubbed `__ModuleLoader__` and a React hook shim, rendering the seat
  component directly: registration contract (inject array / seat `shell.overlay` / order / locale namespace
  / style injection), no color literals in the stylesheet, the official to-do dock selector, no render
  without a session, empty state still rendered and the main content element marked, a turn with only
  timing still counts as content, to-do block (progress, three dot states, project-name title, no "show
  all"), folding above 6 items, goal block (phase / turns / blocked reason), changes block (thousands
  separator, totals, click opens the official change review with the right address and `index`), loading
  and failure states, timing line (`This turn 4m12s` + `model 42s · tools 18s · waiting 3m12s`, no waiting
  segment before `turn/end`, nothing rendered for an empty turn), subagent block (running and failed dots,
  label main line, title · mode · activity sub line, token and time on two lines, whole row clickable,
  teammate row not clickable, missing `uiWorkspace` does not throw, rows bare and full width, separator
  between rows), collapse and re-expand, the no-`document` degradation path, multi-pane marking,
  `⟳` refetch, marker removal on unload. Host half: cross-turn de-duplication and last-touch semantics,
  empty seq / missing service degradation, route 400, `no-store`, log scanning (seq, plans, increments,
  object change, absent session).
- Gates and push, 19 assertions: 1200 renders, 700 keeps only the anchor with `data-card-visible="false"`,
  820/819 boundary, 700→1200 restores the card, three measurement-failure modes treated as "room
  available", collapsed state still gated, fold survives restore, official to-do marker removed and
  restored with the gate, `.sc_anchor` stays an absolutely positioned permanent container, panel gate AND
  width gate; push: no push on wide viewports, `1200+768` pushes 368px, `1000+920` pushes to the limit and
  auto-collapses with the push recomputed for the button, manual expand not immediately reverted, width
  change reverts a manual expand, `1400+920` auto-expands, unmeasurable column width falls back to 820
  without writing padding, `prefers-reduced-motion` disables the transition, hysteresis dead zone
  (1300 collapsed → 1340 still collapsed → 1360 expands).
- Background jobs, covered by `F21` / `F22` with a stubbed `jobs` service: running rows are always listed and
  finished rows fold behind the "n finished" header and stay collapsed even when nothing is running
  (expanded only by a click), the row
  structure matches the host panel (dot / kind pill / mono label / settled reason / duration), the duration
  is formatted as `54秒`-style Chinese units and ticks once alive, stop is a two-step control that only calls
  `kill(sessionId, jobId)` on the second click, the three `data-kill-state` values (`idle` / `armed` /
  `pending` / `failed`), a rejected `kill` answers `{ ok: false }` and shows "Stop failed", `watchRows` is
  called with the main session id, clearing finished rows is local-only, and the whole block disappears when
  `ctx.jobs` is absent.
- Feature assertions, 36: to-do block expanded by default and its fold state, plan block titles/count and
  two-segment `dsh-resource://plan/<sid>/<callId>` address (five-segment address for sub-sessions), plans
  ordered by `seq` descending with the "Untitled plan" fallback, goal buttons per phase with `{ id,
  revision }`, inline textarea edit with trimmed commit and blank-draft guard, `role="alert"` on host
  rejection, optimistic hide on clear, read-only degradation when the goal service or the CAS reference is
  missing, lazy `ctx.inject` for the right panel and goal service (the plugin's `inject` array is never
  extended), changes grouping with the current turn first, per-language file-type kinds and colors.
  Layout assertions 13: 372px card / 16px padding / 28px rows / 16px icon column, block separators with no
  line before the first block, hover pill overflowing 6px each side, totals block, marker-token colors for
  `+/−` (the `--dsw-alias-code-diff-*` tokens are 8–12% **backgrounds**, so they would be invisible as
  text), three text levels only, icon sizes limited to 10/12/14/16, 34px collapse button, header buttons
  28×28 with 16px glyphs, timing line at the same width as the content and with no background/radius/border,
  progress bar arithmetic and the three check states, section heads with the title as their first child and
  no leading icon at 15px.
- Newer assertions: plans/agents per delegation turn (F19), waiting frozen after `turn/end` (F20),
  accent-color theme (TH1–TH5: four presets mapping onto host scales, `--sc-accent` following
  `--sc-theme`, `--sc-accent-weak` derived with `color-mix`, old `--sc-ok` gone, one family for ring / dot /
  bar / pill, default `data-sc-theme="green"`, settings block in `plugins.bundle.config`, summary view
  returns `null`, four dots with only green `aria-pressed="true"`, all copy from locale, persistence and
  whitelist fallback, write failure still applies the change for the session).
- Panel gate, 4 assertions.
- Host half, 8 assertions: `inject` must be an **array** (an object form leaves the fiber PENDING and
  `apply` never runs), no `ctx.on('session/event')` seq accumulation in the source (the real host did not
  deliver those events), log scan of `workspace/changes` and `exit_plan_mode` (PTC keeps only the last
  event, incremental rescan continues from `lastSeq`), `sessionIndex` per session object plus scanned
  length, route 400 without `sessionId`, `no-store` and `lastSeq` / `lastTurn` / `plans` / `timing` in the
  payload, timing fold semantics (model / tools pairing by callId, approvals and questions into `waitMs`,
  question span excluded from `toolMs`, unsettled waits closed at `turn/end`, new turn resets the account,
  orphan `tool/result` ignored), incremental rescan keeping timing state, and the three non-overlapping
  waiting segments (plan approval counted as waiting and not as tool time, an approval window subtracted
  from `toolMs`, sum ≤ wall clock, `waitSince` null after `turn/end`).
- Mutation testing, 103 mutations, each required to turn a named assertion from PASS to FAIL: background
  regressions (`bg-overlay`), removed hide-official-panel rule, gates stuck open, anchor disappearing with
  the card, unknown width treated as no room, lost `Math.round`, `>=`→`>`, marker not following the gate,
  layout regressions (280px card, 16px title, missing total, alpha-based diff colors, `auto` columns,
  caption text level, 10px check glyph, progress not multiplied by 100, running check drawn as done,
  timing line indented one more `--sc-pad`, seconds-only formatting, waiting label in strong color,
  subagent metrics merged into one line and so on), plan-address regressions, `revision` dropped from the
  CAS reference, optimistic hide missing, plan ordering, subagent grouping (F19) and waiting freeze (F20).

## On a live host

- Accent color: after a refresh (a `link:` install picks up the new module without a host restart) the card
  root reports `data-sc-theme="green"` and `--sc-accent` resolves to `#22c55e`. The plugin detail page shows
  the "Accent color" row between the description and the component list, four dots at
  `rgb(34,197,94)` / `rgb(65,118,230)` / `rgb(245,158,11)` / `rgb(239,68,68)`, green selected. Clicking blue
  writes `localStorage['dsh-status-card:theme']="blue"`, the card turns `#4176e6` immediately and stays blue
  after a page reload; an illegal stored preset (`indigo`) falls back to green after reload; clicking green
  restores `#22c55e`.
- Changed-files block produced real data after a host restart: 6 files, totals `+337 / -97`, matching the
  official "Edited 6 files" card. (Before the fix the block was empty: the root cause was that
  `session/event` never reached the plugin on the real host, which is why the host half scans the log.)
- Layout: card 372×610 (and 372×788 in another session) in the documented block order, 26–28px round header
  buttons with 16px glyphs, collapsed state = a 34×34 button sharing the card's right edge, timing line and
  rows sharing the same left and right edges, section heads with no leading icon, subagent rows as
  `button[data-sc-action=open-agent]` with two metric lines (`1.4M tok` / `8m10s`, also `2.7M`/`16m38s`,
  `2.6M`/`11m57s`, `210K`/`1m8s`, `708K`/`8m15s`).
- Text levels measured: row text `rgb(15,17,21)`, labels and counts `rgb(97,102,107)`, icons and counts
  `rgb(129,133,140)`; diff numbers `13px/600` in `rgb(1,162,65)` / `rgb(186,39,35)`.
- Collapse animation: `transform-origin` resolves to `345px 29px`; at 60ms the card is `scale .853 /
  opacity .78` while the button is `scale .848 / opacity .49`; at 190ms the card is `scale .16` with
  `visibility:hidden`. The three centers (header collapse button, collapsed button, transformed origin)
  resolve to the same page coordinate.
- Push / auto-collapse, measured by changing the viewport:
  viewport 2100 (content 1820, column 1010) → no push, 24px gap; viewport 1800 (content 1520, column 1010)
  → `padding-right: 290px`, 19px gap; viewport 1600 (content 1320) → auto-collapse into the 34px button,
  64px gap, a manual expand works (`data-state=card`) even though it overlaps the column by 59px, and a
  `resize` without a width change does not revert it; viewport 1560 (content 1280) → the manual expand is
  dropped and the card collapses again.
- Running spinners (dark theme, viewport 2560, dpr 2): `.sc_mark[data-state=running]::after` is 10×10 with
  `border-top-width: 1.5px`, `animation: sc_spin .8s linear infinite`, two samples 200ms apart show
  different `transform` angles, `border-top-color: rgb(122,170,255)`; the to-do check uses the same
  animation with `rgb(34,197,94)`. With `prefers-reduced-motion: reduce` both stop animating and stay as
  static rings.
- To-do rows in their slimmed form: `.sc_progress` computes to `2px`; a completed `.sc_check` has a
  transparent background, a `1.4px rgb(34,197,94)` border and a 14×14 check glyph.
- Teammate de-duplication: with one teammate plus its sub-session the block shows exactly one row (the
  sub-session, dot `done`) and the count pill reads `1`, matching the official subagent directory; before
  the fix the same queue produced two rows, one of them stuck on `running`.
- Background jobs on a live page (viewport 2560, dpr 2, dark theme): the block rendered between "Changed
  files" and "Subagents" with the title "后台任务", a muted "1 个后台任务运行中" tail, one live row (a real
  `sleep 90` job: spinner dot, mono command at full 276px width, `bash` pill, duration ticking `8秒 → 13秒`,
  a 20×20 square stop button at `data-kill-state=idle`) and the finished group (`› 已结束 4` + "清空",
  collapsed by default); opening it revealed four settled rows showing `exit code: 0` and `54秒` /
  `1分24秒` / `4分9秒` / `1秒`. Measured against the
  host panel: same row order (live first by start time, finished by finish time), same 20×20 button size,
  same `-90deg → 0` chevron, same hairline above the group header.
- Turn timing: after the host restart the route returns
  `{turn:20, modelMs:163965, toolMs:183922, waitSince:null}` and the line shows `This turn 5m48s` +
  `model 2m44s · tools 3m04s`. With an injected probe carrying `idleSince` (15s ago) four consecutive
  samples stay at `This turn 1m08s` (no growth); switching the probe to `waitSince` (5s ago) makes the
  waiting segment tick `10s → 10s → 12s` while the total grows. Both probes were restored afterwards.
- Timing line with no surface: `.sc_bar` computes to `margin: 2px 0 8px`, `padding: 0`, transparent
  background, no radius, no border; label, section titles and the to-do check ring all start at the same x.
  Label `12px/400 rgb(129,133,140)`, total value `12px/600 rgb(97,102,107)`, identical to the segment
  values (all inherited from `.sc_timing`).
- Offline fold of a real session log (5 turns, 11 sub-sessions) with the new timing code: turn 5 tool time
  dropped from 181m37s to **1m09s** (a 180m `plugin_manager` approval is no longer counted twice), waiting
  188m10s (≈ approval 180m + questions 7m43s), every turn's model + tools + waiting ≤ its wall clock, and
  `subagentTurns` placed the 11 sub-sessions in turns 1 / 3 / 5 (3 + 4 + 4).

## Still unverified

- The **goal action buttons** (edit / pause / resume / clear) have never been clicked on a live host: the
  to-do block and the goal block render, but `remote.goals.*` calls are covered only by assertions, and
  `activation` (armed/disarmed) is not in the projection, so a disarmed-but-active goal answers
  `GOAL_INVALID_TRANSITION` and the card shows that error verbatim.
- File-type icons were only seen for markdown / JavaScript / JSON (markdown `rgb(65,118,230)`, js
  `rgb(245,158,11)`, json `rgb(247,173,49)`); ts / py / rs / go / java / C family / shell / css / config /
  sql colors and glyphs are only covered by assertions.
- The whole card in **dark theme** was not re-read end to end (the theme and text levels were measured in
  light theme; the spinners were measured in dark). Right-panel open/close following was not inspected for
  smoothness, and the whitespace left above the composer after hiding the official to-do dock was not
  reviewed.
- Clicking a changed-file row (does it really switch the official change-review pane to that file), and
  whether `remote.goals` reaches the profile's `dsh-goal` on a live host, remain unchecked.
- The last release (0.21.1) changed both halves (`wait` interval table, `subagentTurns`, turn grouping): the
  host half needs a `dsh web` restart, the client half only a page reload. The client half was checked on a
  live page (card renders, no console errors); the restart-time behavior of the new host fold is covered by
  the offline log run above plus assertions.
- The **background-jobs stop button was never clicked on a live host**: the live page only had a running job
  observed (rendering, ticking duration, chevron, clear), while `ctx.jobs.kill` success / failure and the
  `armed` superscription are covered by `F21` with a stubbed service. Whether `kill` reaches the host job
  controller in a real profile is therefore still unconfirmed.
- The plugin marketplace's nightly build is outside this repository: whether `screenshots.json` is picked
  up, and how the store card looks, can only be confirmed after it runs.
