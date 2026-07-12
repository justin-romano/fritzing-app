# Fritzing Breadboard Autorouter Handover

## Objective

Build a breadboard autorouter that:

1. Places physically breadboard-compatible components on the selected board.
2. Leaves panel controls, jacks, power supplies, and modules off-board.
3. Preserves the schematic and logical netlist.
4. Produces no unresolved ratsnests.
5. Optimizes lexicographically: fewest board jumpers, shortest jumper length, then shortest component leads.
6. Re-running Autoroute replaces the previous generated route instead of duplicating it.
7. One Undo restores the complete pre-autoroute state.

Do not hide failures with fallbacks. Validate the live Fritzing connector graph and report exact failures.

## Current Implementation

Primary files:

- `src/autoroute/breadboardautorouter.cpp`
- `src/autoroute/breadboardautorouter.h`
- `src/autoroute/breadboardtopology.cpp`
- `src/autoroute/breadboardtopology.h`
- `src/autoroute/breadboardpartpolicy.cpp`
- `src/autoroute/breadboardpartpolicy.h`
- `src/autoroute/breadboardroutegraph.cpp`
- `src/autoroute/breadboardroutegraph.h`
- `src/autoroute/breadboardroutingscore.cpp`
- `src/autoroute/breadboardroutingscore.h`

The JavaScript prototype remains under `experiments/breadboard-router-prototype/`, but current work is in Fritzing C++.

### Architecture

- `BreadboardTopology` discovers boards, holes, buses, bounds, and reserved holes from actual scene geometry. Do not assume rails or a standard board shape.
- `BreadboardPartPolicy` classifies parts as board-placeable, peripheral, or ignored using physical role and metadata.
- Placement assigns each component pin to a specific breadboard hole and rejects overlaps, same-bus shorts, and invalid geometry.
- Bendable components receive explicit rubber-band leg polygons ending at assigned holes.
- Net routing uses breadboard buses as graph nodes and creates wires only between electrically separate groups.
- Off-board peripherals are connected to breadboard anchors. Do not directly wire one off-board peripheral to another.
- Generated routes are tagged and cleared before a subsequent autoroute.
- The complete operation is wrapped in one undo macro.

## Latest Fix: Detached Placed Pins

The user reported an 8.2k resistor whose rendered leads appeared not to connect to its holes.

Changes made:

- Placement `ChangeConnectionCommand` now calls `setUpdateConnections(false)`, matching Fritzing's native autorouter behavior. The exact pin/hole pair is authoritative; geometry recalculation during movement must not detach it.
- Added `verifyPlacedConnections()` immediately after placement commands execute.
- Every newly placed mapping now requires:
  - pin directly contains the assigned hole in `connectedToItems()`;
  - hole reciprocally contains the pin;
  - a bendable leg endpoint is within 1 scene unit of the assigned hole.
- Any failure returns `-1`, ends and undoes the autoroute macro, displays details, and prevents routing.

The release GUI run at 2026-07-11 14:14 verified all newly placed mappings. In particular:

- `8.2kΩ Resistor:connector0 -> Mini Breadboard:A5`, endpoint distance `0`.
- `8.2kΩ Resistor:connector1 -> Mini Breadboard:C15`, endpoint distance `0`.

Evidence:

- `artifacts/missing-connection-check/fritzing-breadboard-autorouter.log`
- `artifacts/missing-connection-check/20260711-141444-fritzing-window.png`

Important: that screenshot was captured while routing was still running. The connector audit is valid, but the final routed visual result was not captured in that run.

## Known Good Results Before Latest Fix

A fresh `fuzz.fzz` run previously reached:

- 9 placed parts.
- 16 total generated wires.
- 10 peripheral leads.
- 6 actual board jumpers.
- 0 residual ratsnests.
- About 5 seconds elapsed in release.

These numbers are a regression baseline, not proof of optimality.

## Verified 2026-07-11 (afternoon session)

1. DONE - Full release GUI run on `fuzz.fzz`: success, 9 parts placed, 16 wires (6 board jumpers + 10 peripheral leads), 0 failed nets, ~4.9 s, status bar "No connections to route". All placement mappings verified with endpoint distance ~0. Artifacts: `artifacts/router-check/`.
2. DONE - Zero residual ratsnests with the `setUpdateConnections(false)` change.
3. DONE - Second Autoroute cleared all 16 previous wires and created 17 fresh ones, no duplication (`clear previous: removed=16`). Note: the re-route over the existing placement produced 7 board jumpers vs 6 on fresh placement (`placed=0` path routes slightly worse) - see optimization item below.
4. DONE - One Undo restores the exact clean document state. Verified twice: via Edit menu ("Undo Breadboard autoroute", single step, title asterisk cleared) and via a single Ctrl+Z in the Close flow. The macro (`beginMacro`..`endMacro` in `start()`) is balanced on all paths; log confirms `count delta=1, index=1`.

GUI testing gotchas discovered (also documented in the fritzing-gui-smoke skill):

- A focused line edit (the zoom box) consumes Ctrl+Z for its own text undo, so the app Undo action never fires. Alt+E/Enter menu driving is the deterministic way to test undo. Ctrl+Shift+A is unaffected.
- Clicking the canvas to fix focus can select a generated wire and change what a single Ctrl+Z undoes.
- The smoke script now: watches the autorouter log for the `autoroute end` marker instead of blind sleeps (`-WatchLog`), verifies the shortcut landed (log recreated) and resends once, confirms Fritzing owns the foreground before sending keys, re-resolves the window handle before capture, and `-Action Close` undoes until the title is clean so no save prompt blocks exit (`undosSent`/`stillDirty` in output).
- Always finish a test sequence with `-Action Close`; leaving instances open confuses the next run and the user.

## Leg/lead quality work 2026-07-11 (late afternoon)

User reported pronounced zigzag leads on placed passives. Root causes found and fixed (uncommitted, in working tree):

1. `translatedLegForTarget()` preserved the loose sketch's historical bend points and snapped only the endpoint - now synthesizes a straight root-to-hole lead.
2. The rigid placement branch never rewrote legs at all, so translated bent shapes survived - placement now emits straight-lead `ChangeLegCommand`s for rigid moves too (and counts them in `componentLeadLength`, so that metric grew; it is now more honest).
3. Remaining "zigzags" were straight legs leaving the body off-axis (diagonal hole pairs) plus the part SVG's fixed lead stubs. Added to the bendable candidate score: perpendicular-drift penalty (x4) and fold-back compression penalty (x6).
4. The body was always centered between its two holes, which forces fold-back when the net's buses are closer together than the pin spacing (the 470R case). The bendable search now also tries sliding the body along its pin axis in 9-unit pitches (0, +-9 ... +-36).

Result on `fuzz.fzz`: board jumpers 6 -> 5, failedNets 0, straight readable leads (see `artifacts/leg-fix5/route/`). A diagnostic "leg audit" logs any rubber-band leg with >2 points at end of autoroute (there should be none).

Cost: the axial-shift search multiplied bendable candidates ~9x; elapsed went ~5 s -> ~21 s release. Needs pruning (e.g. skip shifts when the centered candidate already has zero compression, or index free holes instead of scanning all pairs).

Also learned: leg polygons are straight but the rendered lead includes the part SVG's fixed stub, so apparent kinks can be placement geometry, not leg data. The zoom box focus quirk and menu-driven undo testing are documented in the fritzing-gui-smoke skill.

## Session 2026-07-12: tuning sliders, pruning verified, netlist stress file

- Toolbar tuning sliders added for the breadboard router (breadboard view only): Stretch (lead stretch limit), Jumpers (bus-mismatch penalty), Length, Angle, Foldback + Reset. `MainWindow::createBreadboardRouterTuning` (mainwindow.cpp, inserted via `getButtonsForView`), persisted in QSettings group `breadboardAutorouter/`, read by `BreadboardAutorouter::loadTuning()` at every start() and logged as `tuning:`. Sliders use Qt::NoFocus so they cannot swallow Ctrl+Z.
- Placement search pruning is real and verified (earlier "no effect" measurements were caused by builds silently failing: the build bat was run from the wrong CWD, so five successive tests re-ran a stale exe - always check the exe LastWriteTime vs source). fuzz.fzz: 21 s -> 2.6 s. Search itself: 2,300-3,700 ms/part -> 9-82 ms/part (see `bendable search profile` log lines). Optimizations: annulus distance filter before bus test, analytic 3-shift selection instead of 9 fixed pitches, per-run hole->bus-id hash + hole position cache, hoisted per-pair scene lookups, early score cutoff before net-cost evaluation.
- `experiments/netlist-to-fzz/generate.mjs` generates test .fzz files from a netlist (currently a ~46-part Big Muff Pi, `F:\docs\Fritzing\stress\bigmuff.fzz`). Connectivity is emitted as schematic-view wires only; parts load loose around a full-size breadboard. Placement on it: 39 parts in 6.9 s, visually clean.
- OPEN BUG found via bigmuff: sketches whose connectivity exists only as schematic-view wires get NO breadboard ratsnest wires on load ("No connections to route" in the status bar). Placement works (collectAllNets sees the nets) but routeCollectedNets/countUnresolvedNets rely on the ratsnest model, so peripheral wiring is skipped entirely (wiredPeripheral=0, totalWires=0) and the run reports success. Either force a ratsnest rebuild before routing, or derive routing demands from collectAllNets instead of ratsnests.
- GUI harness gotcha: a fresh Fritzing restores the last-active view; Ctrl+Shift+A dispatches per current view (PCB tab -> maze router!). Always send Ctrl+1 (breadboard) before Ctrl+Shift+A in automation.

## Parallelization program (started 2026-07-12)

Plan: C:\Users\Administrator\.claude\plans\now-im-going-full-pure-lemur.md (approved). Committed through Stage 0 instrumentation.

Stage 0 baselines (phase-summary lines, exe of 2026-07-12 15:17):

- fuzz.fzz: clear=0 collect=0 placeSearch=525 placeExec=1 routeSearch=2279 routeExec=51 completion=0 total=2872ms, score 0 failed / 5 jumpers.
- stress.fzz (F:\docs\Fritzing\stress.fzz, 2 boards ~1700 holes, 40-pin DIP + breakouts): placeSearch=50806 routeSearch=302402 routeExec=196 completion=489 total=353936ms, score 6 failedNets, placed only 19 parts (DIP placement suspected failing - Stage 1.5).

ROOT CAUSE FOUND (routeSearch): BreadboardRouteGraph's constructor (breadboardroutegraph.cpp buildStaticEdges, line ~171) does all-bus-pairs x all-hole-pairs edge building (plus a congestion scan over plannedSegments per candidate edge), and the graph is RECONSTRUCTED per net and per entry-candidate inside routeCollectedNets/routeRatsnestDemands (graph ctor call sites ~1654, ~1906, ~1985). Fix: construct once per routing pass; keep reserved-hole filtering at query time (edgeAvailable already does); move congestion from construction-time edge cost to an additive query-time term; prune bus pairs spatially by maxJumperLength; int bus ids instead of QString keys. Log buffering and bus memoization are already in (placement search 470->125ms on fuzz; routeSearch unaffected at ~2.2s because of the above).

KEY FINDING: routeSearch dominates (79%/85%) — routing SEARCH, not command execution (51/196ms). Stage 4 (routing) promoted onto the critical path; profile inside routeCollectedNets next (suspects: collectCandidateGroups O(n^2) bus pairing per net, routingCandidatesForSubnet re-walks). Unit tests: repo uses Boost.Test (tests/auto/test_breadboard_routing_score); new pure kernels land test-first, GUI smoke only for end-to-end acceptance.

## LSM303C failed-nets root cause (2026-07-12, log: artifacts/stage4e/stress)

All 6 residual ratsnests on stress.fzz belong to the LSM303C breakout, and the cause is policy, not routing: its connectors are FEMALE header sockets, so BreadboardPartPolicy sees "pins=0 -> class=Ignore" (the log even shows topology briefly considering it a board: "topology owner candidate: holes=10 owner=LSM303C"). Its nets therefore never enter peripheral wiring. Double exclusion: routeCollectedNets' off-board terminal collection also skips female connectors explicitly. The SCP1000 (male pins, class=Peripheral pins=7) wired fine.

Fix design: (1) BreadboardPartPolicy - a non-breadboard part with only female pins classifies as Peripheral, not Ignore; (2) peripheral terminal collection accepts female connectors on peripheral parts (jumpering into a female header is physically standard). Guard: must not reclassify actual breadboards - the policy check runs on parts the topology did NOT accept as boards.

## Unresolved Work

1. Reduce board jumpers without breaking connectivity. Optimize in strict priority order:
   - failed/unresolved nets;
   - board jumper count;
   - board jumper length;
   - component lead length;
   - congestion/crossings only after the above.
   Known concrete sub-issue: routing over an already-placed board (`placed=0`, e.g. the second autoroute) yields more jumpers than fresh placement+routing (7 vs 6 pre-slide-search; recheck with the new code). `tests/benchmarks/breadboard_autoroute_sweep.ps1` exists for parameter sweeps.
2. Prune the bendable axial-shift search back toward ~5 s (see leg quality notes above).
3. Add automated tests for scoring, topology, connection verification, repeated autoroute, and undo behavior (`tests/auto/` already has `test_breadboard_routing_score`).

Do not accept green-looking holes or absence of ratsnests as sufficient proof. Check direct connector relationships, assigned buses, and rendered leg endpoints.

## Build

Use release unless a debugger is specifically required. The debug executable has unrelated runtime/assert and heap problems when loading FZZ files.

```powershell
cmd.exe /c build-msvc64\copilot-build-release.bat
```

VS Code tasks and launch configurations are restored under `.vscode/`:

- `Fritzing: Build Release`
- `Fritzing: Build Debug`
- `Fritzing Release - fuzz.fzz`
- `Fritzing Debug - fuzz.fzz`

The `.vscode/` directory is currently untracked.

## GUI Automation

Read this skill before GUI testing:

`C:\Users\Administrator\.codex\skills\fritzing-gui-smoke\SKILL.md`

Script:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\.codex\skills\fritzing-gui-smoke\scripts\fritzing_gui_smoke.ps1 `
  -ExePath F:\src\fritzing-app\release64\Fritzing.exe `
  -FzzPath F:\docs\Fritzing\fuzz.fzz `
  -OutDir F:\src\fritzing-app\artifacts\router-check `
  -Action Smoke -KillExisting -SendKeys '^+a' -WaitSeconds 20
```

The shortcut `Ctrl+Shift+A` invokes breadboard Autoroute. Confirm the fresh log contains the new start timestamp; GUI automation can focus the wrong window.

Always close Fritzing after a test and verify no process remains:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\.codex\skills\fritzing-gui-smoke\scripts\fritzing_gui_smoke.ps1 `
  -ExePath F:\src\fritzing-app\release64\Fritzing.exe `
  -OutDir F:\src\fritzing-app\artifacts\router-check `
  -Action Close -NoLaunch

Get-Process Fritzing -ErrorAction SilentlyContinue | Stop-Process -Force
```

## Logging

Autorouter logs are copied into the selected artifact directory. Useful searches:

```powershell
rg -n "placement verified|verification failed|route counters|residualRatsnests|autoroute end" artifacts\router-check\fritzing-breadboard-autorouter.log
```

The route logger is currently too noisy because repeated off-board candidate skips are logged inside search loops. Reduce that noise after correctness is stable.

## Working Tree Rules

The repository is dirty and contains user or prior-agent changes. Do not revert unrelated work.

Current top-level status includes:

- modified breadboard autorouter source/header;
- untracked `.vscode/`;
- untracked `artifacts/`;
- untracked `experiments/`.

Use `rg` for searches and `apply_patch` for manual edits. Keep changes scoped and build after C++ changes.

## CRITICAL correctness bug (2026-07-12, user-caught): routing shorts foreign buses

After autorouting stress.fzz the SCHEMATIC shows new ratsnest demands from the M5450's unused outputs (out 26/27/28...) to live nets: the router created connections that do not exist in the schematic - shorts. Mechanism: occupancy is checked per HOLE, not per BUS. Jumpers and routed hops may land in a column whose other holes host a foreign part pin; that pin joins the jumper's net. No-net pins (unused DIP outputs - still real outputs!) are skipped by the placement conflict guards entirely, making them bus-transparent.

Fix (FIRST ITEM next session, outranks all speed work):
1. Route graph QueryContext gains bus-level blocking: a bus is traversable/landable only if it hosts no part pins from other nets (prepare() needs the querying net's own connector set to exempt).
2. Placement conflict guards treat ANY placed pin (netted or not) as claiming its bus against foreign nets.
3. Boost test: synthetic board with a foreign pin mid-column - route must detour or fail, never land there; placement must not put a foreign-net pin on that bus.
4. Verify on stress.fzz: schematic view shows ZERO new ratsnests after autoroute (this is the acceptance test - eyeball plus countUnresolvedNets-style scan of schematic-view ratsnest wires could automate it).

Note: user's schematic file is not modified by routing; the dashes are live ratsnest overlays from the bad breadboard connections. Single Undo clears them.
