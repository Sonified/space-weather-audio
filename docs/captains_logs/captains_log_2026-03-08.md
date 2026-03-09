# Captain's Log — 2026-03-08

## Summary
Blitzed through the study TODO list. Robert brain-dumped ~30 items, I triaged into three tiers (straightforward / needs-a-quick-answer / complex), then spawned 14 parallel agents across ~15 minutes. All completed. But the audit reveals problems.

## What Got Done (14 branches)

### Green tier (no input needed) — 8 agents
1. `fix/question-text-contrast` — Darker question text colors
2. `fix/answer-options-no-panel` — Removed panel box around answer options
3. `fix/likert-text-alignment` — Matched gap (8px→4px) between label grid and radio grid
4. `fix/preview-banner-subtle` — Full banner → small upper-left label
5. `fix/chained-no-flash` — Added question type to modal preservation logic
6. `fix/chained-step-number` — Chain-relative numbering (2 of 5 not 1 of 1)
7. `fix/preview-jump-participant-id` — Store/display preview ID on step jump
8. `fix/builder-circle-colors` — Jewel tone palette for step indicators

### Yellow tier (quick guidance from Robert) — 6 agents
9. `feature/advanced-mode-local-default` — Uses existing `isLocalEnvironment()`
10. `feature/question-go-back` — Can Go Back toggle in builder
11. `feature/panel-lock-icons` — Visual 🔒 icons, vertical circle alignment
12. `feature/confidence-dropdown` — "This is an EMIC event" / "This might be"
13. `feature/test-mode-url` — TEST_XXXXX participant IDs, data flagged
14. `feature/min-features-to-proceed` — "Minimum Features to proceed:" field, default 1

### Red tier (needs Robert's input) — not started
15. Registration cleanup (modes are confusing)
16. Audit what participant data isn't saving
17. App settings overhaul + sync conflicts
18. Study builder publish flow (auto-publish?)
19. Admin key share link UX
20. GOES time region data prep
21. Randomization spec for analysis mode

---

## 🚨 AUDIT: Critical Issues Found

### Issue 1: Agents stacked, not independent
All agents worked on the **same local checkout**. Instead of 14 independent branches, we got a **linear commit chain**. Each agent committed on top of the previous one's work. The "branches" are just pointers at different points in this chain.

**Stack A** (12 fixes, sequential):
```
feature/study-builder
  → fix/preview-banner-subtle (0 unique commits — NO-OP!)
  → fix/builder-circle-colors (1 commit)
  → fix/preview-jump-participant-id (1 commit)
  → fix/question-text-contrast (1 commit)
  → fix/chained-step-number (same tip as above)
  → fix/chained-no-flash (2 commits)
  → fix/likert-text-alignment (1 commit)
  → fix/answer-options-no-panel (1 commit)
  → feature/advanced-mode-local-default (1 commit)
  → feature/panel-lock-icons (1 commit)
  → feature/confidence-dropdown (1 commit)
  → feature/question-go-back (points here but MISSING its own commit!)
```

**Stack B** (3 fixes, separate chain):
```
feature/study-builder
  → d92b150 Add 'Can Go Back' toggle (this should be on feature/question-go-back!)
  → feature/test-mode-url (0 unique commits — NO-OP!)  
  → 6d2ca3e Add min features
  → f93cb3e Add test mode
  → feature/min-features-to-proceed (tip)
```

### Issue 2: Two branches are empty no-ops
- `fix/preview-banner-subtle` — zero diff from feature/study-builder. The preview banner fix landed on OTHER branches instead.
- `feature/test-mode-url` — zero diff. The test mode commit landed on feature/min-features-to-proceed.

### Issue 3: feature/question-go-back is wrong
The branch points at the confidence-dropdown tip (009d642). The actual "Can Go Back" commit (d92b150) ended up on feature/min-features-to-proceed.

### Issue 4: All work is based on REVERTED code
Main's HEAD (1723429) is a **revert** of the study platform commit (6440480). All branches fork from feature/study-builder which is downstream of the reverted commit. None of these branches can merge cleanly to main.

### Issue 5: Collateral changes
Most branches carry ~663 extra lines of study-builder.html changes and other files unrelated to their task, because the working tree was dirty when they branched.

---

## Recommended Fix

**Don't try to merge 14 branches individually.** Instead:

1. **Identify the two tips that contain all the work:**
   - `feature/confidence-dropdown` (Stack A tip — has 11 of the fixes)
   - `feature/min-features-to-proceed` (Stack B tip — has go-back, test-mode, min-features)

2. **Merge Stack B into Stack A** to get one branch with everything

3. **Rebase or merge onto main** (which means un-reverting the study platform, or rebasing the study platform + fixes onto main)

4. **Review the combined diff** — much easier than 14 PRs

---

## Lesson Learned
When spawning parallel agents that touch the same repo, they need to work on **separate clones or worktrees** — not the same checkout. Otherwise they serialize and cross-contaminate. Future parallel repo work should use `git worktree add` per agent.
