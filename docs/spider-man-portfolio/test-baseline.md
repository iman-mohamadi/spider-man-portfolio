# Test Baseline Report (M0 Phase B)

Documentation-only. No test file, source file or configuration was changed to produce these numbers.

Labels: **[M]** measured by running the command, **[V]** verified by reading code/output, **[A]** assumption, **[R]** recommendation.

- Run date: 2026-10-31
- Machine: Windows 11 Pro 10.0.26300, Node v24.11.1, npm 11.6.2, Python 3.12.10 (real interpreter) — but `python3` on PATH resolves to the Microsoft Store alias `C:\Users\EnzO\AppData\Local\Microsoft\WindowsApps\python3.exe` **[M]**
- Repository state: branch `main`, no commits, all files untracked **[V]**
- No `package.json` exists, so there is no `npm test` script **[V]**

## 1. Commands tried and what they do on this environment

| Command | Exit | Result |
|---|---|---|
| `node --test "tests/**/*.test.cjs" "tests/**/*.test.mjs"` | 1 | **225 tests, 223 pass, 2 fail, 0 skipped, 0 cancelled, 0 todo**, duration 2,352 ms **[M]** |
| `node --test` (no arguments, auto-discovery) | 1 | Identical: 225 tests, 223 pass, 2 fail, duration 2,444 ms **[M]** |
| `node --test tests/` (directory form) | 1 | `Error: Cannot find module 'C:\Projects\spider-man-portfolio\tests'` `MODULE_NOT_FOUND` — **0 tests run** **[M]** |

**Supported command in this environment:** the glob form from the roadmap works and is confirmed. The bare `node --test` also works and is shorter. The directory form fails on Node 24 (Node treats the argument as a module path), confirming the earlier finding **[M]**.

Test inventory **[M]**: 28 test files (26 `.cjs`, 2 `.mjs`) plus `tests/helpers/module.cjs`. The suite is fast apart from two heavyweight tests (the geodata build ≈ 30 s when it can run; see below).

## 2. Failures — exact messages and classification

> **Correction to the earlier architecture review.** The review stated that both failures call `python3`. That was wrong. **Only one does.** The other fails because Windows denies creating a directory symlink.

### F1 — `tests/geodata.test.mjs:10` "geodata builds with default paths in a checkout containing spaces and non-ASCII characters"

```
Error: EPERM: operation not permitted, symlink 'C:\Projects\spider-man-portfolio\tools\data' -> 'C:\Users\EnzO\AppData\Local\Temp\New York 東京 yPlr8f\tools\data'
    at Object.symlinkSync (node:fs:1879:11)
    at TestContext.<anonymous> (tests/geodata.test.mjs:19:8)
```

- Cause **[V]**: the test calls `fs.symlinkSync(…, 'dir')` (line 19). Creating a *directory symlink* on Windows needs Developer Mode or an elevated process.
- **Environmental [M, verified two ways]:**
  1. A scratchpad probe: `symlinkSync(…,'dir')` → `EPERM`; `symlinkSync(…,'junction')` → OK.
  2. A scratchpad copy of the same test with only two differences (the repo root made absolute, and `'dir'` → `'junction'`) **passed**: `✔ … (29,566 ms)`, 1 test, 0 fail. The copy builds the geodata into a temp directory (the build script writes next to its own copied location) and never wrote into the repository.
- Not a code regression. Would pass with Developer Mode enabled or on macOS/Linux/CI **[A]** (not tested there).

### F2 — `tests/tree-geodata.test.cjs:54` "tree generator filters and deduplicates locations, and signed deltas round trip"

```
Error: Command failed: python3 -B -c  import runpy, sys … m = runpy.run_path('tools/build-trees.py') …
Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases.
  status: 9009
```

- Cause **[V]**: `execFileSync('python3', …)` at `tests/tree-geodata.test.cjs:55`; `python3` here is the Store stub.
- **Environmental [M]:** running only that file with a temporary `python3.exe` shim (a copy of the real `python.exe` placed in a scratchpad folder, put on `PATH` for that single command, together with `PYTHONHOME`) gives **4/4 pass** (`✔ tree generator filters and deduplicates locations…`). The shim and the probe folders were deleted afterwards. No system setting, PATH entry or repo file was changed.
- Not a code regression.

## 3. Summary

| Item | Value |
|---|---|
| Total tests | 225 |
| Passed | 223 |
| Failed | 2 (both environmental) |
| Skipped / cancelled / todo | 0 / 0 / 0 |
| **Environmental failures** | **2** (F1: Windows symlink privilege; F2: `python3` Store alias) |
| **Actual code regressions** | **0** |
| Effective baseline | **225/225 pass in a correctly configured environment** (each failure independently shown to pass once its environmental cause is removed; both removals were done outside the repo) |

## 4. What this baseline does and does not cover

- It covers pure-logic and harness-based tests of: geodata/building/tree data, the map, cameras' pointer handling, controllers' keyboard/car physics/teleport/collision, touch controls, traffic and pedestrian logic, materials, boot-time HTML rules.
- It does **not** cover rendering, WebGPU, shader compilation, real browsers, `main.js` initialisation, `localStorage` save/restore, gamepad handling, audio sources or the traffic player hitbox (see the characterization plan in `m0-execution-report.md`).
- The suite runs in Node with stubs; **a pass is not evidence that the game renders or performs correctly** **[V]**.

## 5. Reproduction

```bash
node --test                                    # 225 tests; expect the 2 environmental failures on this machine
node --test "tests/**/*.test.cjs" "tests/**/*.test.mjs"   # equivalent
```

To remove the environmental failures without touching the repo (user's choice, not applied): enable Windows Developer Mode (fixes F1) and either install Python from python.org with the `python3` launcher alias or disable the Store alias (fixes F2) **[R]**. These are system settings and were deliberately **not** changed.
