// main.ts is mend, the CLI SPEC.md specifies (MIT). It covers all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits made, in order (for the `R` output lines). */
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

/** One line of a hunk or chunk: context, deleted, or added. `noNL` is set when a `\` line follows it. */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNL: boolean;
}

/** Line equality at a matching tier (SPEC.md section 5). */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Positions where O occurs in lines at a tier; occurrences may overlap. */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, or null when it occurs at no tier. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrencesAt(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The old lines of ops (context and deleted, in body order). */
function oldLinesOf(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.text);
}

/** The new lines of ops (context and added, in body order). */
function newLinesOf(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'del').map((o) => o.text);
}

/** Whether a `\` line follows the last context or added line of the ops. */
function lastOutputNoNL(ops: Op[]): boolean {
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i]!;
    if (o.kind === 'ctx' || o.kind === 'add') return o.noNL;
  }
  return false;
}

/**
 * Replace the k lines at `at` (the occurrence of the ops' old lines) with the ops' new lines.
 * Context lines are written as the file's own matched lines; at tier 2 every other new line is
 * re-indented from O's first line to the file's first matched line (SPEC.md section 5).
 */
function applyOps(lines: string[], at: number, ops: Op[], tier: number): string[] {
  const oLines = oldLinesOf(ops);
  const out = lines.slice(0, at);
  const f = at < lines.length ? leadWs(lines[at]!) : '';
  const p = oLines.length > 0 ? leadWs(oLines[0]!) : '';
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(lines[at + oi]!);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else if (tier === 2 && !onlyWs(op.text) && op.text.startsWith(p)) {
      out.push(f + op.text.slice(p.length));
    } else {
      out.push(op.text);
    }
  }
  out.push(...lines.slice(at + oLines.length));
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk (SPEC.md section 6). */
interface Hunk {
  /** Old start line, 1-based, from the header. */
  a: number;
  ops: Op[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  pairSeen: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed. */
function unifiedPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  return raw.replace(/^[ab]\//, '');
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one hunk starting at lines[i] (an `@@` line); return the hunk and the next index. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const raw: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const ops: Op[] = [];
  for (const l of raw) {
    if (l === '') ops.push({ kind: 'ctx', text: '', noNL: false });
    else if (l[0] === ' ') ops.push({ kind: 'ctx', text: l.slice(1), noNL: false });
    else if (l[0] === '-') ops.push({ kind: 'del', text: l.slice(1), noNL: false });
    else if (l[0] === '+') ops.push({ kind: 'add', text: l.slice(1), noNL: false });
    else if (ops.length > 0) ops[ops.length - 1]!.noNL = true;
  }
  return { hunk: { a, ops }, next: j };
}

/**
 * Parse a section's header lines and hunks starting at index i, stopping at the next section
 * start or the end of the patch; return the next index.
 */
function parseSection(lines: string[], i: number, sec: Section): number {
  // Header: until the first hunk.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sec.pairSeen) return i;
        sec.oldPath = unifiedPath(l);
        sec.newPath = unifiedPath(lines[i + 1]!);
        sec.pairSeen = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) {
      sec.renameFrom = l.slice('rename from '.length);
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.renameTo = l.slice('rename to '.length);
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.create = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  // Hunks (and ignored lines outside bodies) until the next section.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const r = parseHunk(lines, i);
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    i += 1;
  }
  return i;
}

/** Apply a section's hunks in order to a file's model (SPEC.md section 6). */
function applyHunks(m: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const o = oldLinesOf(h.ops);
    const n = newLinesOf(h.ops);
    if (o.length > 0) {
      const found = findTier(m.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = found.occ[0]!;
      let best = Math.abs(at - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          at = p;
        }
      }
      const runsToEnd = at + o.length === m.lines.length;
      m.lines = applyOps(m.lines, at, h.ops, found.tier);
      if (runsToEnd) m.final = !lastOutputNoNL(h.ops);
    } else {
      const beforeLen = m.lines.length;
      const at = Math.min(h.a + d, beforeLen);
      m.lines = applyOps(m.lines, at, h.ops, 0);
      if (at === beforeLen) m.final = !lastOutputNoNL(h.ops);
    }
    d += n.length - o.length;
  }
}

/** One unified section as an edit. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.oldPath ?? sec.renameFrom ?? sec.gitOld;
  const newPath = sec.newPath ?? sec.renameTo ?? sec.gitNew;
  const create = oldPath === null || sec.create;
  const del = !create && (newPath === null || sec.del);
  const move = !create && !del && oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree) => {
    if (create) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noNL = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) {
          if (op.kind === 'add') {
            plus.push(op.text);
            noNL = op.noNL;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (del) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (move) {
      const o = oldPath!;
      const nw = newPath!;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(nw)) throw new Fail('unsafe', nw);
      const cur = tree.get(o);
      if (cur === null) throw new Fail('missing', o);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const m = splitFile(cur);
      applyHunks(m, sec.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(nw, joinFile(m));
      tree.moves.push({ old: o, new: nw });
      return;
    }
    const p = oldPath ?? newPath ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const m = splitFile(cur);
    applyHunks(m, sec.hunks, strict, p);
    tree.now.set(p, joinFile(m));
  };
}

/** Unified diffs (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = {
        oldPath: null,
        newPath: null,
        pairSeen: false,
        renameFrom: null,
        renameTo: null,
        gitOld: m[1]!,
        gitNew: m[2]!,
        create: false,
        del: false,
        hunks: [],
      };
      i = parseSection(lines, i + 1, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = {
        oldPath: null,
        newPath: null,
        pairSeen: false,
        renameFrom: null,
        renameTo: null,
        gitOld: null,
        gitNew: null,
        create: false,
        del: false,
        hunks: [],
      };
      i = parseSection(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const m = splitFile(cur);
    const found = findTier(m.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ kind: 'del', text: t, noNL: false })),
      ...newLines.map((t): Op => ({ kind: 'add', text: t, noNL: false })),
    ];
    m.lines = applyOps(m.lines, found.occ[0]!, ops, found.tier);
    tree.now.set(path, joinFile(m));
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

/** One V4A chunk (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

const V_SECTION = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Collect one V4A chunk's body lines starting at lines[i]. */
function collectVChunk(
  lines: string[],
  i: number,
  last: number,
): { ops: Op[]; eof: boolean; next: number; endKind: 'at' | 'eof' | 'section' } {
  const ops: Op[] = [];
  while (i < last) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return { ops, eof: false, next: i, endKind: 'at' };
    if (l === '*** End of File') return { ops, eof: true, next: i + 1, endKind: 'eof' };
    if (V_SECTION(l)) return { ops, eof: false, next: i, endKind: 'section' };
    if (l === '') {
      ops.push({ kind: 'ctx', text: '', noNL: false });
      i += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      ops.push({ kind: 'ctx', text: l.slice(1), noNL: false });
      i += 1;
      continue;
    }
    if (c === '-') {
      ops.push({ kind: 'del', text: l.slice(1), noNL: false });
      i += 1;
      continue;
    }
    if (c === '+') {
      ops.push({ kind: 'add', text: l.slice(1), noNL: false });
      i += 1;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return { ops, eof: false, next: i, endKind: 'section' };
}

/** One V4A Update File section as an edit. */
function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundIdx = -1;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && foundIdx < 0; t++) {
          for (let j = cursor; j < m.lines.length; j++) {
            if (tierEq(m.lines[j]!, ch.anchor, t)) {
              foundIdx = j;
              break;
            }
          }
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      const o = oldLinesOf(ch.ops);
      const n = newLinesOf(ch.ops);
      if (o.length === 0) {
        const at = ch.eof ? m.lines.length : cursor;
        m.lines = applyOps(m.lines, at, ch.ops, 0);
        cursor = at + n.length;
      } else {
        let pick: { tier: number; at: number } | null = null;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && pick === null; t++) {
          for (const p of occurrencesAt(m.lines, o, t)) {
            if (p < cursor) continue;
            if (ch.eof && p + o.length !== m.lines.length) continue;
            pick = { tier: t, at: p };
            break;
          }
        }
        if (pick === null) throw new Fail('no-match', path);
        m.lines = applyOps(m.lines, pick.at, ch.ops, pick.tier);
        cursor = pick.at + n.length;
      }
    }
    const text = joinFile(m);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

/** V4A patches (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const secLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (V_SECTION(l)) break;
        if (l.startsWith('+') || l === '') {
          secLines.push(l);
          i += 1;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      const addLines = secLines.map((l) => (l === '' ? '' : l.slice(1)));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (V_SECTION(l)) break;
        if (blank(l)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let firstChunk = true;
      while (i < last) {
        const l = lines[i]!;
        if (V_SECTION(l)) break;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          i += 1;
          const r = collectVChunk(lines, i, last);
          if (r.endKind === 'section') {
            while (r.ops.length > 0 && r.ops[r.ops.length - 1]!.kind === 'ctx' && r.ops[r.ops.length - 1]!.text === '') r.ops.pop();
          }
          chunks.push({ anchor: anchorText === '' ? null : anchorText, ops: r.ops, eof: r.eof });
          i = r.next;
          firstChunk = false;
          if (r.endKind === 'eof') {
            while (i < last && blank(lines[i]!)) i++;
          }
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
          const r = collectVChunk(lines, i, last);
          if (r.endKind === 'section') {
            while (r.ops.length > 0 && r.ops[r.ops.length - 1]!.kind === 'ctx' && r.ops[r.ops.length - 1]!.text === '') r.ops.pop();
          }
          chunks.push({ anchor: null, ops: r.ops, eof: r.eof });
          i = r.next;
          firstChunk = false;
          if (r.endKind === 'eof') {
            while (i < last && blank(lines[i]!)) i++;
          }
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const suppressed = new Set<string>();
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.new) === null && tree.get(mv.new) !== null) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      suppressed.add(mv.old);
      suppressed.add(mv.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
