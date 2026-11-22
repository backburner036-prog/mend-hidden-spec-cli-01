# mend-hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/backburner036-prog/mend-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/backburner036-prog/mend-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** is one patch tool for every AI edit format. It applies an edit an AI model wrote — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON — to a tree of text files. Every file is changed or nothing is: a failed edit changes nothing, and the edits after it still run, so every failure is reported. Node 22, standard library only, no dependencies.

## Run it

```sh
node main.ts patch.diff
node main.ts --check --format=search-replace fix.patch
cat patch.diff | node main.ts -
```

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree). When absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## The four formats

- **Unified diff** — sections (`diff --git`, `---`/`+++`, rename, new/deleted file mode) and hunks. Line numbers may be wrong: a hunk takes the occurrence nearest to its stated position, adjusted for earlier hunks. Creates, deletes and moves files, including `R old -> new` output lines.
- **SEARCH/REPLACE** — blocks with a path line, `<<<<<<< SEARCH`, `=======`, `>>>>>>> REPLACE`. The old lines must occur exactly once.
- **V4A** — `*** Begin Patch` / `*** End Patch` with `*** Add File:`, `*** Delete File:`, `*** Update File:` (plus `*** Move to:`) sections and `@@` anchors, a cursor that moves through the file, and `*** End of File` chunks.
- **JSON** — one array of edit objects, or JSON Lines: `create`, `str_replace`, `insert`.

## Matching

Old lines are found at the first of three tiers where they occur: tier 0 (every line equal), tier 1 (trailing spaces/tabs ignored), tier 2 (leading and trailing spaces/tabs ignored, new lines re-indented to the file). `--strict` tries tier 0 only. Context lines are always written as the file's own lines. CRLF files stay CRLF; a file without a final line break keeps it, unless a unified hunk's `\ No newline at end of file` says otherwise.

## Output and exit codes

- Exit 0: one line per changed path (`A`/`D`/`M`/`R`), then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then `failed: <k> of <n> edits`. Nothing is written.
- Exit 2: one line — `error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>`.

The full contract is `SPEC.md`. `check.ts` runs the practice set: `node check.ts ../program/generator/practice.json` scores 100/100.

---

<sub>Entered on [make.fun](https://make.fun/?ref=szf4tywk&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
