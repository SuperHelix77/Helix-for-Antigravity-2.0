# Benchmark Evidence

## Antigravity NEW50 Benchmark (Gemini 3.8 Flash High)

The full 50-task SWE-bench NEW50 cohort was evaluated on Google Antigravity (`agy`) using `gemini-3.8-flash-high` with `effort: high` in both lanes across continuous unreset conversations.

| Measure | Vanilla Antigravity | HELIX Antigravity | Empirical Delta | Impact / Multiplier |
| --- | :---: | :---: | :---: | :---: |
| **Tasks Evaluated** | **50 / 50** | **50 / 50** | 0 | 100% Cohort Evaluated |
| **Official Solves** | **11 / 50 (22.0%)** | **10 / 50 (20.0%)** | -1 Solve | **90.9% Solve Parity** |
| **Total Billable Tokens** | **452,661,692** | **172,259,815** | **-280,401,877** | **61.95% Net Savings (2.63x Efficiency)** |
| **Total Cached Context** | **10,503,585,319** | **1,426,600,795** | **-9,076,984,524** | **86.42% Context Reduction (7.36x Efficiency)** |
| **Output / Gen Tokens** | 35,076,090 | 10,041,570 | -25,034,520 | 71.38% Reduction |
| **Reasoning / Thinking Tokens** | 24,127,579 | 8,266,825 | -15,860,754 | 65.74% Reduction |
| **Mean Billable / Task** | 9,053,234 tokens | 3,445,196 tokens | -5,608,038 tokens | -5.61M tokens / task |
| **Mean Cache / Task** | 210,071,706 tokens | 28,532,016 tokens | -181,539,690 tokens | -181.5M cached tokens / task |

### Solve Distribution Across 50 Tasks
- **Both Solved (8 Tasks):** `django__django-15061`, `django__django-11422`, `django__django-11583`, `django__django-14999`, `django__django-14752`, `django__django-14017`, `django__django-16379`, `sympy__sympy-20212`
- **Vanilla Only (3 Tasks):** `django__django-14534`, `django__django-13448`, `django__django-11564`
- **HELIX Only (2 Tasks):** `django__django-15213`, `django__django-12453`

### Anti-Contamination & Integrity Controls
1. **Zero Synthetic Calls:** 100% of execution tokens originated from live Google Antigravity CLI invocations (`agy --model gemini-3.8-flash-high`) recording authentic provider receipts.
2. **Zero Contamination:** Neither lane had access to gold patches, dataset solutions, historical transcripts, or pre-computed diffs.
3. **Continuous Context Preservation:** Both lanes preserved continuous session continuity across all 50 tasks in dedicated UUID conversations without per-task context resets.
4. **Independent Official SWE Evaluation:** Solutions were graded automatically against the official repository test suites in isolated testbeds with dedicated Python environments (`.venv311`).

All 100 receipts and results are preserved in [benchmarks/benchmark-results.json](../benchmarks/benchmark-results.json).

## Historical Codex V3 Release Result

V3's full same50 comparison is now officially graded: vanilla 38/50, modified 34/50. Primary known tokens are 50,686,068 versus 11,288,140 (77.73% fewer); output is 55,283 versus 75,814 (37.14% more). This did not meet output-reduction, solve-parity or 85-90% reduction targets.

Only exact confirmed provider-overload errors are excluded symmetrically from primary accounting: vanilla 5 and modified 3. Primary requests are 341 versus 420; all-attempt requests are 346 versus 423. One non-overload modified request has unknown usage. Two rejected post-completion operations remain included (71,221 known tokens, 309 output); the native solver was terminated after all grades rather than claiming a clean exit.

Failed tasks consumed 87 primary requests / 14,541,601 known tokens in vanilla (12 failed issues), versus 144 / 4,222,112 in V3 (16 failed issues). Those numbers are subsets of lane totals, not extra costs to add again. They count requests and environment commands, not inferred semantic repair attempts.

All 100 official task grades, 50 gold controls, submitted patch digests, 2,150 unchanged launch bindings and 77 external bindings were checked. Seven explicitly mutable journals/state files changed as expected. Cold recovery verified 261 result-store originals, 758 program-store originals, 417 archived pairs and all 92 advertised aged-result handles. No actual native compaction occurred.

See [sanitized V3 results, failure effort and cumulative rows](../benchmarks/new50-v3/results.json) and [cumulative CSV](../benchmarks/new50-v3/cumulative.csv). New release RTK/memory/UI integrations were not present as measured RTK/Claude-Mem treatments in this run. Their integration tests do not establish additional provider-token savings. Earlier v1/v2 discussion below is historical, not a claim of an ongoing benchmark.

## Design

The public cohort contains 50 SWE-bench Lite instance IDs, repository names, base commits and fixed order. Raw model requests, native sessions, hidden test/gold patches, personal memory, credential-bearing files and private recovery stores are excluded.

V1 used native Sol 6.1 High and normal medium output in each lane, with one continued context per lane across 50 tasks. Infrastructure capacity resumes are retained rather than described as an uninterrupted process. Per-task context resets were not used. Official harness results, not solver self-reports or focused tests alone, determine solved outcomes.

V2 reuses the same known issues and historical vanilla results. It creates only one fresh modified native context and proceeds back-to-back, without a fresh context per issue. This is a post-hoc historical comparison, not a new holdout, new vanilla run, paired concurrent experiment or causal component ablation.

An issue's environment must pass source/image checks and an official gold control before its first inference. Gold controls and hidden tests stay controller-side, outside the solver's mounted public data. An unpatched official negative control checks that the first environment does not falsely report a solution. Current-task native MCP checkpoints are audited. General failure qualification rejects a successful shell exit when a recognized test summary still reports failures or no tests.

## Accounting

Include every recorded request, retry, failed issue, failed command and finalization request. A missing provider usage receipt is unknown, never zero. Known subtotals can be compared, but are not complete token totals when unknowns remain. Output includes reasoning tokens where reported; reasoning is a subset, not an additional amount to add to total output.

Cumulative monitor ratios compare only a contiguous prefix with official grades in both lanes. Full historical vanilla totals cannot be compared to a partially completed modified run as if they were savings. Failed attempts remain in the lane totals and in the matched prefix for their issue.

The benchmark does not measure complete billed price, subscription quota consumption, root orchestrator inference, local CPU cost or all setup/recovery overhead. Therefore total cost per verified solve remains unestablished. Preflight failures and retries are retained privately and described, not quietly removed; local synthetic zero-provider tests are not quality benchmarks.

## V1 Result

| Measure | Vanilla | Modified v1 |
| --- | ---: | ---: |
| Official solves | 38 | 36 |
| Failed issues | 12 | 14 |
| Requests | 346 | 317 |
| Known input | 50,630,785 | 17,304,315 |
| Known output | 55,283 | 66,505 |
| Known reasoning subset | 6,504 | 15,452 |
| Known total | 50,686,068 | 17,370,820 |
| Requests with unknown usage | 5 | 3 |
| Failed-issue requests | 88 | 93 |
| Environment commands | 100 | 216 |
| Failed-issue environment commands | 29 | 68 |
| Native compactions observed | 0 | 0 |

Known total reduction was 65.7286%. Output increased 20.2992%, and solve parity was not achieved. The known subtotal for failed issues was 14,541,601 vanilla tokens plus one unknown request, versus 6,338,661 modified tokens. Lower known token use does not erase failed outcomes or establish lower total cost per successful solution.

Exact provider item attribution reconciled all known output:

| Output class | Vanilla | Modified v1 |
| --- | ---: | ---: |
| Tool programs | 43,790 | 47,668 |
| Visible prose | 4,989 | 3,385 |
| Reasoning subset | 6,504 | 15,452 |
| Total output | 55,283 | 66,505 |

The increase was primarily reasoning, not user-visible prose. Checkpoint programs accounted for 9,327 modified output tokens, but only 1,244 reasoning tokens. Real repair loops on two tasks explained much of the reasoning growth. The v2 treatment targets repeated operational scaffolding, literal verification boundaries and typed recovery; it does not force shorter thinking or reduce effort. It may still regress and must be judged by its official results.

## Context Defaults

The native catalog advertised 500k context with no threshold override. Real observed input peaks were 268,031 vanilla and 102,192 modified. A pinned SDK offline probe with unchanged native settings produced no compaction at synthetic 300k/440k, and one ordinary Responses no-tools compaction at 460k. Thus zero compactions in the actual lower-context run does not show that compaction was disabled. The probe bounds observed behavior; it is not proof of an exact universal threshold, preserved intelligence or measured savings.

See [offline probe evidence](native-compaction-proof.json). The v2 adapter's general no-tools passthrough has separate offline negative controls; candidate prompt telemetry cannot authorize deterministic compaction.

## Public Artifacts And Reproduction Limits

- [Fixed cohort](../benchmarks/new50-cohort.json): public task identifiers and base revisions only.
- [V1 aggregate](../benchmarks/new50-v1/results.json): validated numeric/enum projection and explicit unknowns.
- [V1 per-issue CSV](../benchmarks/new50-v1/per-issue.csv): outcomes, attempts, known subtotals, cumulative values and unknown counts.
- [V1 output attribution](../benchmarks/new50-v1/output-attribution.json): reconciled numeric classes and source hashes, without raw generations.

The exporter reconstructs allowlisted fields, validates the fixed cohort and rejects arbitrary source strings/CSV columns. A source hash identifies a local audited artifact; it does not let a reader recover an unpublished file. Private raw traces and historical authentication are intentionally not sufficient public reproduction material. These sanitized reports support the stated accounting, not independently reproducible full model execution.

No RTK executable was present in the v1 lanes. No personal Claude-Mem database was imported. Isolated public goal/evidence memory was used. Keep these facts separate from the optional external integrations in the release package.

The development monitor and private launch helper are not a turnkey public SWE-bench distribution. Running another benchmark requires separately authorized model usage, licensed/public task data, reviewed environments and explicit official grading. It must not silently reuse private state or label a different task set as NEW50.
