# mend

One patch tool for every AI edit format. `mend` reads a patch written by
a model and applies it to a tree of text files — every file, or none.

## Formats

- **Unified diffs** (`diff --git`, `---`/`+++`, `@@` hunks) — line numbers
  are only a hint: each hunk is found by content at the first of three
  matching tiers (exact, trailing whitespace, both sides trimmed), nearest
  to its stated position.
- **SEARCH/REPLACE blocks** (`<<<<<<< SEARCH` / `=======` /
  `>>>>>>> REPLACE`) — the old lines must occur exactly once.
- **V4A patches** (`*** Begin Patch` … `*** End Patch`) — add, delete and
  update sections, with anchors and a moving cursor.
- **JSON edits** — one array of edit objects, or one object per line:
  `create`, `str_replace`, `insert`.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file; with no patch, or `-`, the patch is read from
standard input. `--format` picks one format (`unified`, `search-replace`,
`v4a`, `json`); the default `auto` detects it. `--check` reports what
would change without writing anything. `--strict` matches lines exactly
(tier 0 only).

On success it prints one line per changed file (`A`, `D`, `M`, or
`R old -> new`) and `ok: <n> files`, and exits 0. On failure it prints
one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits`, writes nothing, and exits 1. Usage, unreadable
patch, undetected format and parse errors exit 2 with a single
`error: ...` line. See SPEC.md for the full contract.

## Files

- `main.ts` — the CLI (entrypoint).
- `runner.ts` — the trial runner: when `MAKEFUN_ENV_URL` is set, `main.ts`
  hands over to it, and it runs the CLI on every check the trial env
  lists and posts the results.
- `check.ts` — runs `main.ts` on the 100 public practice checks and
  compares each run with its expected outcome: `node check.ts`.
