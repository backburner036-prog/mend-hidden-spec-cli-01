// mend: apply an AI-written edit to a tree of text files.
//
// Reads one patch in four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls), finds the lines each edit names at the
// first of three matching tiers, and writes every change or none.
// Written from SPEC.md. Node 22, standard library only.
//
// When MAKEFUN_ENV_URL is set, this file hands over to runner.ts: the
// trial runner that runs the CLI on every check the env lists.

import * as fs from "node:fs";
import * as path from "node:path";
import { runTrial } from "./runner.ts";

// ---------- tiny helpers ----------

function isBlank(s: string): boolean {
  return s.trim() === "";
}

function stripTrailingWs(s: string): string {
  return s.replace(/\s+$/, "");
}

// A patch's lines: split at \n, one trailing \r removed from each, and no
// empty piece after a final \n.
function splitPatchLines(text: string): string[] {
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// ---------- file model ----------

// A file is its lines plus the line break it uses (CRLF when its first
// line feed follows a carriage return, LF otherwise) plus whether its
// text ends with that break. An empty file has no lines and no break.
type FileState = { lines: string[]; eol: string; ends: boolean };

function textToFile(text: string): FileState {
  if (text === "") return { lines: [], eol: "\n", ends: false };
  let eol = "\n";
  const firstNl = text.indexOf("\n");
  if (firstNl > 0 && text[firstNl - 1] === "\r") eol = "\r\n";
  const parts = text.split(eol);
  let ends = false;
  if (text.endsWith(eol)) {
    parts.pop();
    ends = true;
  }
  return { lines: parts, eol, ends };
}

function fileToText(f: FileState): string {
  if (f.lines.length === 0) return "";
  return f.lines.join(f.eol) + (f.ends ? f.eol : "");
}

function cloneFile(f: FileState): FileState {
  return { lines: [...f.lines], eol: f.eol, ends: f.ends };
}

// The tree, held in memory: files are read from disk on first touch, and
// nothing is written until every edit has been judged.
class Tree {
  private cache = new Map<string, FileState | null>();
  private blockedSet = new Map<string, boolean>();
  private initial = new Map<string, FileState | null>();

  get(p: string): FileState | null {
    if (!this.cache.has(p)) {
      let st: FileState | null = null;
      let blocked = false;
      try {
        const s = fs.statSync(p);
        if (s.isFile()) st = textToFile(fs.readFileSync(p, "utf8"));
        else blocked = true;
      } catch {
        st = null;
      }
      this.cache.set(p, st);
      this.blockedSet.set(p, blocked);
      this.initial.set(p, st === null ? null : cloneFile(st));
    }
    return this.cache.get(p) ?? null;
  }

  // True when a regular file is there.
  existsFile(p: string): boolean {
    return this.get(p) !== null;
  }

  // True when anything at all is there (a file, or a directory in the way).
  existsAny(p: string): boolean {
    return this.get(p) !== null || (this.blockedSet.get(p) ?? false);
  }

  set(p: string, st: FileState | null): void {
    this.get(p);
    this.cache.set(p, st === null ? null : cloneFile(st));
  }

  touchedPaths(): string[] {
    return [...this.initial.keys()];
  }

  initialText(p: string): string | null {
    const st = this.initial.get(p);
    return st === undefined || st === null ? null : fileToText(st);
  }

  finalText(p: string): string | null {
    const st = this.cache.get(p);
    return st === undefined || st === null ? null : fileToText(st);
  }
}

// ---------- matching (SPEC section 5) ----------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, "");
  return line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

// Every 0-based position where O's lines match the file's lines at a tier.
function occurrences(fileLines: string[], oLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oLines.length === 0 || oLines.length > fileLines.length) return out;
  const oNorm = oLines.map((l) => normLine(l, tier));
  for (let i = 0; i + oLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oLines.length; j++) {
      if (normLine(fileLines[i + j], tier) !== oNorm[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier with an occurrence at or after fromPos (and, for an
// end-of-file chunk, ending at the file's last line); its first position.
function findFirstAt(
  fileLines: string[],
  oLines: string[],
  fromPos: number,
  strict: boolean,
  endAtLast: boolean,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, oLines, t).filter(
      (p) => p >= fromPos && (!endAtLast || p + oLines.length === fileLines.length),
    );
    if (occ.length > 0) return { tier: t, pos: occ[0] };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

type OLine = { text: string; isContext: boolean };

// Render N's lines. A context line is written as the file's own matched
// line, never the patch's. At tier 2 every other line is re-indented:
// the leading whitespace of O's first line is replaced by that of the
// file's first matched line.
function renderNewLines(
  nLines: OLine[],
  fileLines: string[],
  pos: number,
  oLines: OLine[],
  tier: number,
): string[] {
  const ctxFile: string[] = [];
  for (let j = 0; j < oLines.length; j++) {
    if (oLines[j].isContext) ctxFile.push(fileLines[pos + j]);
  }
  let ctxIdx = 0;
  const f = tier === 2 && oLines.length > 0 ? leadingWs(fileLines[pos]) : "";
  const p = tier === 2 && oLines.length > 0 ? leadingWs(oLines[0].text) : "";
  const out: string[] = [];
  for (const nl of nLines) {
    if (nl.isContext) {
      out.push(ctxFile[ctxIdx++]);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== "" && !/^[ \t]*$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

// ---------- edits ----------

type Fail = { code: string; path: string };

type BodyLine = { kind: "ctx" | "old" | "nw" | "bs"; text: string; empty?: boolean };

type Hunk = { a: number; body: BodyLine[] };

type UnifiedSection = {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
};

type VChunk = { anchor: string | null; body: BodyLine[]; eof: boolean };

type Edit =
  | { kind: "unified"; section: UnifiedSection }
  | { kind: "search"; path: string; oldLines: string[]; newLines: string[] }
  | { kind: "v4a-add"; path: string; lines: string[] }
  | { kind: "v4a-delete"; path: string }
  | { kind: "v4a-update"; path: string; moveTo: string | null; chunks: VChunk[] }
  | { kind: "json-create"; path: string; text: string }
  | { kind: "json-replace"; path: string; oldStr: string; newStr: string }
  | { kind: "json-insert"; path: string; line: number; text: string };

// True when a \ line follows the hunk's last context or + line.
function backslashAfterLastCtxOrNew(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === "ctx" || body[i].kind === "nw") last = i;
  }
  if (last === -1) return false;
  return body[last + 1] !== undefined && body[last + 1].kind === "bs";
}

// Apply a section's hunks in order to a file. Returns the new file state,
// or null when a hunk finds no match.
function applyHunks(file: FileState, hunks: Hunk[], strict: boolean): FileState | null {
  let lines = [...file.lines];
  let ends = file.ends;
  let d = 0;
  for (const h of hunks) {
    const oLines: OLine[] = [];
    const nLines: OLine[] = [];
    for (const b of h.body) {
      if (b.kind === "ctx") {
        oLines.push({ text: b.text, isContext: true });
        nLines.push({ text: b.text, isContext: true });
      } else if (b.kind === "old") oLines.push({ text: b.text, isContext: false });
      else if (b.kind === "nw") nLines.push({ text: b.text, isContext: false });
    }
    const oTexts = oLines.map((o) => o.text);
    if (oLines.length === 0) {
      // Insert N after the first A + d lines (all of them when fewer).
      const at = Math.min(h.a + d, lines.length);
      const rendered = renderNewLines(nLines, lines, at, oLines, 0);
      if (at === lines.length) ends = !backslashAfterLastCtxOrNew(h.body);
      lines.splice(at, 0, ...rendered);
      d += nLines.length;
    } else {
      const tiers = strict ? [0] : [0, 1, 2];
      let found: { tier: number; occ: number[] } | null = null;
      for (const t of tiers) {
        const occ = occurrences(lines, oTexts, t);
        if (occ.length > 0) {
          found = { tier: t, occ };
          break;
        }
      }
      if (found === null) return null;
      // Nearest occurrence to A - 1 + d; of two equally near, the earlier.
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rendered = renderNewLines(nLines, lines, best, oLines, found.tier);
      if (best + oLines.length === lines.length) ends = !backslashAfterLastCtxOrNew(h.body);
      lines.splice(best, oLines.length, ...rendered);
      d += nLines.length - oLines.length;
    }
  }
  return { lines, eol: file.eol, ends };
}

// ---------- unified diffs (SPEC section 6) ----------

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/;

// The path after "--- " or "+++ ": text after the four characters, up to
// the first tab, with surrounding spaces removed. /dev/null means no file;
// a leading a/ or b/ is removed.
function unifiedHeaderPath(line: string): string | null {
  const t = line.slice(4).split("\t")[0].trim();
  if (t === "/dev/null") return null;
  if (t.startsWith("a/") || t.startsWith("b/")) return t.slice(2);
  return t;
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let cur: {
    diffOld: string | null;
    diffNew: string | null;
    headOld: string | null;
    headNew: string | null;
    hasPair: boolean;
    renameOld: string | null;
    renameNew: string | null;
    isCreate: boolean;
    isDelete: boolean;
    hunks: Hunk[];
  } | null = null;

  const finish = () => {
    if (cur === null) return;
    let oldPath: string | null;
    let newPath: string | null;
    if (cur.hasPair) {
      oldPath = cur.headOld;
      newPath = cur.headNew;
    } else {
      oldPath = cur.renameOld ?? cur.diffOld;
      newPath = cur.renameNew ?? cur.diffNew;
    }
    edits.push({
      kind: "unified",
      section: {
        oldPath,
        newPath,
        isCreate: cur.isCreate || oldPath === null,
        isDelete: cur.isDelete || newPath === null,
        hunks: cur.hunks,
      },
    });
    cur = null;
  };

  const fresh = (): NonNullable<typeof cur> => ({
    diffOld: null,
    diffNew: null,
    headOld: null,
    headNew: null,
    hasPair: false,
    renameOld: null,
    renameNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const dg = DIFF_GIT_RE.exec(line);
      if (!dg) throw new ParseErr(i + 1);
      finish();
      cur = fresh();
      cur.diffOld = dg[1];
      cur.diffNew = dg[2];
      i++;
      continue;
    }
    if (
      line.startsWith("--- ") &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith("+++ ")
    ) {
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.headOld = unifiedHeaderPath(line);
        cur.headNew = unifiedHeaderPath(lines[i + 1]);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      finish();
      cur = fresh();
      cur.headOld = unifiedHeaderPath(line);
      cur.headNew = unifiedHeaderPath(lines[i + 1]);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith("@@")) {
      const hm = HUNK_RE.exec(line);
      if (!hm) throw new ParseErr(i + 1);
      if (cur === null) throw new ParseErr(i + 1);
      const a = Number(hm[1]);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const L = lines[j];
        if (L.startsWith("diff --git ")) break;
        if (L.startsWith("--- ") && j + 1 < lines.length && lines[j + 1].startsWith("+++ ")) break;
        if (L === "") {
          body.push({ kind: "ctx", text: "", empty: true });
          j++;
        } else if (L.startsWith(" ")) {
          body.push({ kind: "ctx", text: L.slice(1) });
          j++;
        } else if (L.startsWith("-")) {
          body.push({ kind: "old", text: L.slice(1) });
          j++;
        } else if (L.startsWith("+")) {
          body.push({ kind: "nw", text: L.slice(1) });
          j++;
        } else if (L.startsWith("\\")) {
          body.push({ kind: "bs", text: L.slice(1) });
          j++;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0) {
        const lastB = body[body.length - 1];
        if (lastB.kind === "ctx" && lastB.empty) body.pop();
        else break;
      }
      cur.hunks.push({ a, body });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Inside a section's header.
      if (line.startsWith("--- ")) throw new ParseErr(i + 2);
      if (line.startsWith("rename from ")) cur.renameOld = line.slice("rename from ".length).trim();
      else if (line.startsWith("rename to ")) cur.renameNew = line.slice("rename to ".length).trim();
      else if (line.startsWith("new file mode")) cur.isCreate = true;
      else if (line.startsWith("deleted file mode")) cur.isDelete = true;
      // index, old mode, new mode, similarity/dissimilarity index, Index:
      // lines, and any other line, are ignored.
      i++;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i++;
  }
  finish();
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0; // index just after the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (stripTrailingWs(lines[i]) === "<<<<<<< SEARCH") {
      const searchLine = i + 1;
      // The path is the nearest line before SEARCH, after the previous
      // block's REPLACE line, that is not blank and does not start with
      // three backticks; else the previous block's path.
      let p: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j].trim();
        if (t === "" || t.startsWith("```")) continue;
        p = t;
        break;
      }
      if (p === null) {
        p = prevPath;
        if (p === null) throw new ParseErr(searchLine);
      }
      let m = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = stripTrailingWs(lines[j]);
        if (t === "=======") {
          m = j;
          break;
        }
        if (t === ">>>>>>> REPLACE") throw new ParseErr(searchLine);
      }
      if (m === -1) throw new ParseErr(searchLine);
      let r = -1;
      for (let j = m + 1; j < lines.length; j++) {
        if (stripTrailingWs(lines[j]) === ">>>>>>> REPLACE") {
          r = j;
          break;
        }
      }
      if (r === -1) throw new ParseErr(searchLine);
      edits.push({
        kind: "search",
        path: p,
        oldLines: lines.slice(i + 1, m),
        newLines: lines.slice(m + 1, r),
      });
      prevEnd = r + 1;
      prevPath = p;
      i = r + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------- V4A patches (SPEC section 8) ----------

const V4A_SECTION_STARTS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "];

function isV4aSectionStart(line: string): boolean {
  return V4A_SECTION_STARTS.some((s) => line.startsWith(s));
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== "*** Begin Patch") throw new ParseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== "*** End Patch") throw new ParseErr(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const p = line.slice("*** Add File: ".length).trim();
      const collected: string[] = [];
      i++;
      while (i < last) {
        const L = lines[i];
        if (isV4aSectionStart(L)) break;
        if (L === "") {
          collected.push("");
          i++;
          continue;
        }
        if (L.startsWith("+")) {
          collected.push(L.slice(1));
          i++;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      // Blank lines at the end of a section are not part of it.
      while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
      edits.push({ kind: "v4a-add", path: p, lines: collected });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const p = line.slice("*** Delete File: ".length).trim();
      edits.push({ kind: "v4a-delete", path: p });
      i++;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const updateLine = i + 1;
      const p = line.slice("*** Update File: ".length).trim();
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      i++;
      while (i < last) {
        const L = lines[i];
        if (isV4aSectionStart(L)) break;
        if (isBlank(L)) {
          // A blank line inside an open chunk is an empty context line;
          // elsewhere between sections it is ignored.
          if (cur !== null) cur.body.push({ kind: "ctx", text: "", empty: true });
          i++;
          continue;
        }
        if (L.startsWith("*** Move to: ")) {
          if (moveTo !== null || chunks.length > 0 || cur !== null) throw new ParseErr(i + 1);
          moveTo = L.slice("*** Move to: ".length).trim();
          i++;
          continue;
        }
        if (L === "*** End of File") {
          if (cur === null) throw new ParseErr(i + 1);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          i++;
          continue;
        }
        if (L.startsWith("@@")) {
          if (cur !== null) {
            chunks.push(cur);
            cur = null;
          }
          const anchor = L.slice(2).trim();
          cur = { anchor: anchor === "" ? null : anchor, body: [], eof: false };
          i++;
          continue;
        }
        if (L.startsWith(" ") || L.startsWith("-") || L.startsWith("+")) {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseErr(i + 1);
            cur = { anchor: null, body: [], eof: false };
          }
          if (L.startsWith(" ")) cur.body.push({ kind: "ctx", text: L.slice(1) });
          else if (L.startsWith("-")) cur.body.push({ kind: "old", text: L.slice(1) });
          else cur.body.push({ kind: "nw", text: L.slice(1) });
          i++;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      if (cur !== null) {
        chunks.push(cur);
        cur = null;
      }
      if (chunks.length > 0) {
        const b = chunks[chunks.length - 1].body;
        while (b.length > 0) {
          const lastB = b[b.length - 1];
          if (lastB.kind === "ctx" && lastB.empty) b.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(updateLine);
      edits.push({ kind: "v4a-update", path: p, moveTo, chunks });
      continue;
    }
    throw new ParseErr(i + 1);
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------- JSON edits (SPEC section 9) ----------

function validateJsonEdit(v: unknown): Edit {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("bad edit");
  const o = v as Record<string, unknown>;
  if (typeof o["command"] !== "string") throw new Error("bad edit");
  if (typeof o["path"] !== "string") throw new Error("bad edit");
  const cmd = o["command"] as string;
  const p = o["path"] as string;
  if (cmd === "create") {
    if (typeof o["file_text"] !== "string") throw new Error("bad edit");
    return { kind: "json-create", path: p, text: o["file_text"] as string };
  }
  if (cmd === "str_replace") {
    if (typeof o["old_str"] !== "string" || (o["old_str"] as string) === "") {
      throw new Error("bad edit");
    }
    let ns = "";
    if ("new_str" in o) {
      if (typeof o["new_str"] !== "string") throw new Error("bad edit");
      ns = o["new_str"] as string;
    }
    return { kind: "json-replace", path: p, oldStr: o["old_str"] as string, newStr: ns };
  }
  if (cmd === "insert") {
    if (typeof o["insert_line"] !== "number" || !Number.isInteger(o["insert_line"])) {
      throw new Error("bad edit");
    }
    if (typeof o["new_str"] !== "string") throw new Error("bad edit");
    return { kind: "json-insert", path: p, line: o["insert_line"] as number, text: o["new_str"] as string };
  }
  throw new Error("bad edit");
}

function parseJson(lines: string[], patchText: string): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  const firstChar = lines[first].trimStart()[0];
  if (firstChar === "[") {
    // One JSON array of edit objects.
    const startLine = first + 1;
    let v: unknown;
    try {
      v = JSON.parse(patchText);
    } catch {
      throw new ParseErr(startLine);
    }
    if (!Array.isArray(v)) throw new ParseErr(startLine);
    const edits: Edit[] = [];
    for (const item of v) {
      try {
        edits.push(validateJsonEdit(item));
      } catch {
        throw new ParseErr(startLine);
      }
    }
    if (edits.length === 0) throw new ParseErr(1);
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let v: unknown;
    try {
      v = JSON.parse(lines[i]);
    } catch {
      throw new ParseErr(i + 1);
    }
    try {
      edits.push(validateJsonEdit(v));
    } catch {
      throw new ParseErr(i + 1);
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------- format detection (SPEC section 4) ----------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === "*** Begin Patch") return "v4a";
  const c = lines[first].trimStart()[0];
  if (c === "[" || c === "{") return "json";
  for (let i = 0; i < lines.length; i++) {
    if (stripTrailingWs(lines[i]) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      return "unified";
    }
  }
  return null;
}

// ---------- applying edits (SPEC sections 6-10) ----------

function applyUnified(
  s: UnifiedSection,
  tree: Tree,
  strict: boolean,
  moves: [string, string][],
): Fail | null {
  const oldP = s.oldPath;
  const newP = s.newPath;
  if (oldP !== null && !isSafePath(oldP)) return { code: "unsafe", path: oldP };
  if (newP !== null && !isSafePath(newP)) return { code: "unsafe", path: newP };
  if (s.isCreate) {
    const np = newP as string;
    if (tree.existsAny(np)) return { code: "exists", path: np };
    const plus: string[] = [];
    let lastBs = false;
    for (const h of s.hunks) {
      for (let idx = 0; idx < h.body.length; idx++) {
        const b = h.body[idx];
        if (b.kind === "nw") {
          plus.push(b.text);
          lastBs = h.body[idx + 1] !== undefined && h.body[idx + 1].kind === "bs";
        }
      }
    }
    tree.set(np, { lines: plus, eol: "\n", ends: plus.length > 0 ? !lastBs : false });
    return null;
  }
  if (s.isDelete) {
    const op = oldP as string;
    if (!tree.existsFile(op)) return { code: "missing", path: op };
    tree.set(op, null);
    return null;
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    if (!tree.existsFile(oldP)) return { code: "missing", path: oldP };
    if (tree.existsAny(newP)) return { code: "exists", path: newP };
    const cur = tree.get(oldP) as FileState;
    const res = applyHunks(cur, s.hunks, strict);
    if (res === null) return { code: "no-match", path: oldP };
    tree.set(newP, res);
    tree.set(oldP, null);
    moves.push([oldP, newP]);
    return null;
  }
  const p = (oldP ?? newP) as string;
  if (!tree.existsFile(p)) return { code: "missing", path: p };
  const cur = tree.get(p) as FileState;
  const res = applyHunks(cur, s.hunks, strict);
  if (res === null) return { code: "no-match", path: p };
  tree.set(p, res);
  return null;
}

function applySearch(ed: Extract<Edit, { kind: "search" }>, tree: Tree, strict: boolean): Fail | null {
  if (!isSafePath(ed.path)) return { code: "unsafe", path: ed.path };
  if (ed.oldLines.length === 0) {
    if (tree.existsAny(ed.path)) return { code: "exists", path: ed.path };
    tree.set(ed.path, { lines: [...ed.newLines], eol: "\n", ends: ed.newLines.length > 0 });
    return null;
  }
  const cur = tree.get(ed.path);
  if (cur === null) return { code: "missing", path: ed.path };
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(cur.lines, ed.oldLines, t);
    if (occ.length === 0) continue;
    if (occ.length > 1) return { code: "ambiguous", path: ed.path };
    const oLines: OLine[] = ed.oldLines.map((x) => ({ text: x, isContext: false }));
    const nLines: OLine[] = ed.newLines.map((x) => ({ text: x, isContext: false }));
    const rendered = renderNewLines(nLines, cur.lines, occ[0], oLines, t);
    const next = cloneFile(cur);
    next.lines.splice(occ[0], ed.oldLines.length, ...rendered);
    tree.set(ed.path, next);
    return null;
  }
  return { code: "no-match", path: ed.path };
}

function applyV4aAdd(ed: Extract<Edit, { kind: "v4a-add" }>, tree: Tree): Fail | null {
  if (!isSafePath(ed.path)) return { code: "unsafe", path: ed.path };
  if (tree.existsAny(ed.path)) return { code: "exists", path: ed.path };
  tree.set(ed.path, { lines: [...ed.lines], eol: "\n", ends: ed.lines.length > 0 });
  return null;
}

function applyV4aDelete(ed: Extract<Edit, { kind: "v4a-delete" }>, tree: Tree): Fail | null {
  if (!isSafePath(ed.path)) return { code: "unsafe", path: ed.path };
  if (!tree.existsFile(ed.path)) return { code: "missing", path: ed.path };
  tree.set(ed.path, null);
  return null;
}

function applyV4aUpdate(
  ed: Extract<Edit, { kind: "v4a-update" }>,
  tree: Tree,
  strict: boolean,
  moves: [string, string][],
): Fail | null {
  if (!isSafePath(ed.path)) return { code: "unsafe", path: ed.path };
  if (ed.moveTo !== null && !isSafePath(ed.moveTo)) return { code: "unsafe", path: ed.moveTo };
  const cur = tree.get(ed.path);
  if (cur === null) return { code: "missing", path: ed.path };
  if (ed.moveTo !== null && tree.existsAny(ed.moveTo)) return { code: "exists", path: ed.moveTo };
  let lines = [...cur.lines];
  let cursor = 0;
  for (const ch of ed.chunks) {
    if (ch.anchor !== null) {
      const found = findFirstAt(lines, [ch.anchor], cursor, strict, false);
      if (found === null) return { code: "no-match", path: ed.path };
      cursor = found.pos + 1;
    }
    const oLines: OLine[] = [];
    const nLines: OLine[] = [];
    for (const b of ch.body) {
      if (b.kind === "ctx") {
        oLines.push({ text: b.text, isContext: true });
        nLines.push({ text: b.text, isContext: true });
      } else if (b.kind === "old") oLines.push({ text: b.text, isContext: false });
      else if (b.kind === "nw") nLines.push({ text: b.text, isContext: false });
    }
    const oTexts = oLines.map((o) => o.text);
    if (oLines.length === 0) {
      const at = ch.eof ? lines.length : cursor;
      const rendered = renderNewLines(nLines, lines, at, oLines, 0);
      lines.splice(at, 0, ...rendered);
      cursor = at + rendered.length;
    } else {
      const found = findFirstAt(lines, oTexts, cursor, strict, ch.eof);
      if (found === null) return { code: "no-match", path: ed.path };
      const rendered = renderNewLines(nLines, lines, found.pos, oLines, found.tier);
      lines.splice(found.pos, oLines.length, ...rendered);
      cursor = found.pos + rendered.length;
    }
  }
  const res: FileState = { lines, eol: cur.eol, ends: cur.ends };
  if (ed.moveTo !== null) {
    tree.set(ed.moveTo, res);
    tree.set(ed.path, null);
    moves.push([ed.path, ed.moveTo]);
  } else {
    tree.set(ed.path, res);
  }
  return null;
}

function countOverlapping(text: string, sub: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(sub, from);
    if (idx === -1) break;
    n++;
    from = idx + 1;
  }
  return n;
}

function applyJsonCreate(ed: Extract<Edit, { kind: "json-create" }>, tree: Tree): Fail | null {
  if (!isSafePath(ed.path)) return { code: "unsafe", path: ed.path };
  if (tree.existsAny(ed.path)) return { code: "exists", path: ed.path };
  tree.set(ed.path, textToFile(ed.text));
  return null;
}

function applyJsonReplace(ed: Extract<Edit, { kind: "json-replace" }>, tree: Tree): Fail | null {
  if (!isSafePath(ed.path)) return { code: "unsafe", path: ed.path };
  const cur = tree.get(ed.path);
  if (cur === null) return { code: "missing", path: ed.path };
  let text = fileToText(cur);
  let oldS = ed.oldStr;
  let newS = ed.newStr;
  if (cur.eol === "\r\n") {
    text = text.replace(/\r\n/g, "\n");
    oldS = oldS.replace(/\r\n/g, "\n");
    newS = newS.replace(/\r\n/g, "\n");
  }
  const n = countOverlapping(text, oldS);
  if (n === 0) return { code: "no-match", path: ed.path };
  if (n > 1) return { code: "ambiguous", path: ed.path };
  const idx = text.indexOf(oldS);
  text = text.slice(0, idx) + newS + text.slice(idx + oldS.length);
  if (cur.eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  tree.set(ed.path, textToFile(text));
  return null;
}

function applyJsonInsert(ed: Extract<Edit, { kind: "json-insert" }>, tree: Tree): Fail | null {
  if (!isSafePath(ed.path)) return { code: "unsafe", path: ed.path };
  const cur = tree.get(ed.path);
  if (cur === null) return { code: "missing", path: ed.path };
  if (ed.line < 0 || ed.line > cur.lines.length) return { code: "no-match", path: ed.path };
  const ins = splitPatchLines(ed.text);
  const next = cloneFile(cur);
  next.lines.splice(ed.line, 0, ...ins);
  tree.set(ed.path, next);
  return null;
}

function applyEdit(ed: Edit, tree: Tree, strict: boolean, moves: [string, string][]): Fail | null {
  switch (ed.kind) {
    case "unified":
      return applyUnified(ed.section, tree, strict, moves);
    case "search":
      return applySearch(ed, tree, strict);
    case "v4a-add":
      return applyV4aAdd(ed, tree);
    case "v4a-delete":
      return applyV4aDelete(ed, tree);
    case "v4a-update":
      return applyV4aUpdate(ed, tree, strict, moves);
    case "json-create":
      return applyJsonCreate(ed, tree);
    case "json-replace":
      return applyJsonReplace(ed, tree);
    case "json-insert":
      return applyJsonInsert(ed, tree);
  }
}

// ---------- output ----------

// One line per path whose state changed, in byte order of the paths, then
// the ok line. A move that qualifies replaces its D and A lines with one
// R line, sorted by the new path.
function computeChanges(tree: Tree, moves: [string, string][]): string[] {
  type Row = { key: string; line: string; kind: string };
  const rows: Row[] = [];
  for (const p of tree.touchedPaths()) {
    const init = tree.initialText(p);
    const fin = tree.finalText(p);
    if (init === fin) continue;
    if (init === null && fin !== null) rows.push({ key: p, line: `A ${p}`, kind: "A" });
    else if (init !== null && fin === null) rows.push({ key: p, line: `D ${p}`, kind: "D" });
    else rows.push({ key: p, line: `M ${p}`, kind: "M" });
  }
  const used = new Set<Row>();
  for (const [o, n] of moves) {
    const dRow = rows.find((r) => r.kind === "D" && r.key === o && !used.has(r));
    const aRow = rows.find((r) => r.kind === "A" && r.key === n && !used.has(r));
    if (dRow !== undefined && aRow !== undefined) {
      used.add(dRow);
      used.add(aRow);
      rows.push({ key: n, line: `R ${o} -> ${n}`, kind: "R" });
    }
  }
  const kept = rows.filter((r) => !used.has(r));
  kept.sort((a, b) => byteCompare(a.key, b.key));
  return kept.map((r) => r.line);
}

function writeChanges(tree: Tree): void {
  for (const p of tree.touchedPaths()) {
    const init = tree.initialText(p);
    const fin = tree.finalText(p);
    if (init === fin) continue;
    if (fin === null) {
      try {
        fs.unlinkSync(p);
      } catch {
        // Already gone.
      }
    } else {
      const dir = path.dirname(p);
      if (dir !== "." && dir !== "") fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, fin, "utf8");
    }
  }
}

// ---------- invocation (SPEC section 1) ----------

type Args = { format: string; check: boolean; strict: boolean; patch: string | null; usage: boolean };

function parseArgs(argv: string[]): Args {
  let format = "auto";
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional: string[] = [];
  const usage = (): Args => ({ format, check, strict, patch: null, usage: true });
  for (const arg of argv) {
    if (!endOpts && arg === "--") {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg.startsWith("-") && arg !== "-") {
      if (arg === "--check") {
        if (seenCheck) return usage();
        seenCheck = true;
        check = true;
      } else if (arg === "--strict") {
        if (seenStrict) return usage();
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith("--format=")) {
        if (seenFormat) return usage();
        seenFormat = true;
        const v = arg.slice("--format=".length);
        if (v !== "unified" && v !== "search-replace" && v !== "v4a" && v !== "json" && v !== "auto") {
          return usage();
        }
        format = v;
      } else {
        return usage();
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return usage();
  return { format, check, strict, patch: positional.length === 0 ? null : positional[0], usage: false };
}

function writeOut(s: string): void {
  fs.writeSync(1, s);
}

function main(): void {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.usage) {
    writeOut("error: usage\n");
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (args.patch === null || args.patch === "-") {
    try {
      patchText = fs.readFileSync(0, "utf8");
    } catch {
      patchText = "";
    }
  } else {
    try {
      patchText = fs.readFileSync(args.patch, "utf8");
    } catch {
      writeOut("error: no-patch\n");
      process.exitCode = 2;
      return;
    }
  }
  const lines = splitPatchLines(patchText);
  let format = args.format;
  if (format === "auto") {
    const d = detectFormat(lines);
    if (d === null) {
      writeOut("error: format\n");
      process.exitCode = 2;
      return;
    }
    format = d;
  }
  let edits: Edit[];
  try {
    if (format === "unified") edits = parseUnified(lines);
    else if (format === "search-replace") edits = parseSearchReplace(lines);
    else if (format === "v4a") edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (e) {
    if (e instanceof ParseErr) {
      writeOut(`error: parse ${e.line}\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const tree = new Tree();
  const moves: [string, string][] = [];
  const failures: Fail[] = [];
  for (const ed of edits) {
    const f = applyEdit(ed, tree, args.strict, moves);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    const out =
      failures.map((f) => `error: ${f.code} ${f.path}`).join("\n") +
      `\nfailed: ${failures.length} of ${edits.length} edits\n`;
    writeOut(out);
    process.exitCode = 1;
    return;
  }
  const changeLines = computeChanges(tree, moves);
  const n = changeLines.length;
  const out =
    (changeLines.length > 0 ? changeLines.join("\n") + "\n" : "") +
    `ok: ${n} ${n === 1 ? "file" : "files"}\n`;
  if (!args.check) writeChanges(tree);
  writeOut(out);
  process.exitCode = 0;
}

// With MAKEFUN_ENV_URL set, this program is the trial agent: hand over to
// the runner instead of running the CLI. The runner strips the variable
// before it runs node main.ts on each check.
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== "") {
  runTrial(envUrl).then(
    () => undefined,
    (err: unknown) => {
      process.stderr.write(`runner: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
} else {
  main();
}
