/**
 * Static-rule mess detector. Runs cheap checks on each turn's diffs and
 * emits warnings the renderer surfaces as chips above the explanation.
 *
 * v0.1 scope: static rules only — no LLM judge. Each rule is a pure
 * function of the diff (file path, old text, new text) plus optional
 * file content. False positives stay rare because we only fire when
 * the NEW content introduces the smell, not when it inherited it.
 */
import type { TurnSummary, DiffBlock } from './parseTurn.js';

export interface MessFlag {
  rule: string;
  /** very short label for chip display */
  label: string;
  /** longer one-sentence explanation for hover/expand */
  reason: string;
  file: string;
  severity: 'info' | 'warn' | 'error';
}

const TS_EXT = /\.(ts|tsx|js|jsx|mjs)$/i;
const STYLE_EXT = /\.(tsx|jsx)$/i;
const PY_EXT = /\.py$/i;

function newAdditions(d: DiffBlock): string {
  // Naive: assume `new` minus what's in `old` is what's introduced.
  // For an add (Write), old is empty so new IS the additions.
  if (!d.old) return d.new;
  // Lines in new that aren't in old — character-level diffing is overkill,
  // line-level is cheap and good enough for these rules.
  const oldLines = new Set(d.old.split('\n'));
  return d.new
    .split('\n')
    .filter((l) => !oldLines.has(l))
    .join('\n');
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}

function fnLineRanges(text: string, lang: 'ts' | 'py'): number[] {
  // Returns line counts for each function-like block in the diff. Naive
  // but useful: we look for declaration → matched braces (TS) or
  // declaration → next def at same indent (Py).
  const out: number[] = [];
  const lines = text.split('\n');
  if (lang === 'ts') {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i] ?? '';
      if (/^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(public|private|protected|static|async)\s+\w+\s*\(/.test(ln)) {
        // Walk forward counting braces
        let depth = 0;
        let started = false;
        let j = i;
        for (; j < lines.length; j++) {
          for (const ch of lines[j] ?? '') {
            if (ch === '{') {
              depth++;
              started = true;
            } else if (ch === '}') {
              depth--;
              if (started && depth === 0) break;
            }
          }
          if (started && depth === 0) break;
        }
        out.push(j - i + 1);
      }
    }
  } else if (lang === 'py') {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i] ?? '';
      const m = /^(\s*)def\s+\w+/.exec(ln);
      if (!m) continue;
      const indent = m[1]?.length ?? 0;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j] ?? '';
        if (next.trim().length === 0) continue;
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent && /\S/.test(next)) break;
      }
      out.push(j - i);
    }
  }
  return out;
}

function flagFnTooLong(d: DiffBlock): MessFlag[] {
  const adds = newAdditions(d);
  const lang = TS_EXT.test(d.file) ? 'ts' : PY_EXT.test(d.file) ? 'py' : null;
  if (!lang) return [];
  const lengths = fnLineRanges(adds, lang);
  const offenders = lengths.filter((n) => n > 50);
  if (offenders.length === 0) return [];
  return [
    {
      rule: 'fn-too-long',
      label: `fn > 50 lines`,
      reason: `Introduced function spans ${offenders[0]} lines (limit: 50). CLAUDE.md rule.`,
      file: d.file,
      severity: 'warn',
    },
  ];
}

function flagInlineCss(d: DiffBlock): MessFlag[] {
  if (!STYLE_EXT.test(d.file)) return [];
  const adds = newAdditions(d);
  if (/style=\{\{/.test(adds)) {
    return [
      {
        rule: 'inline-css',
        label: 'inline CSS',
        reason: 'Inline `style={{ }}` introduced. Use CSS module or className.',
        file: d.file,
        severity: 'warn',
      },
    ];
  }
  return [];
}

function flagDebugLeftover(d: DiffBlock): MessFlag[] {
  const adds = newAdditions(d);
  const flags: MessFlag[] = [];
  if (TS_EXT.test(d.file) && /^\s*console\.log\(/m.test(adds)) {
    flags.push({
      rule: 'console-log',
      label: 'console.log',
      reason: 'console.log() introduced. Remove before committing or use a logger.',
      file: d.file,
      severity: 'info',
    });
  }
  if (PY_EXT.test(d.file) && /^\s*print\(/m.test(adds)) {
    flags.push({
      rule: 'print',
      label: 'print()',
      reason: 'print() introduced. Use logging instead in production code.',
      file: d.file,
      severity: 'info',
    });
  }
  return flags;
}

function flagAnyType(d: DiffBlock): MessFlag[] {
  if (!TS_EXT.test(d.file)) return [];
  const adds = newAdditions(d);
  // Match ': any' or 'as any' but not 'any' inside a comment
  const re = /(:\s*any\b|\bas\s+any\b)/;
  if (re.test(adds)) {
    return [
      {
        rule: 'any-type',
        label: 'any type',
        reason: 'TS `any` introduced. Document the reason in a comment or type it properly.',
        file: d.file,
        severity: 'info',
      },
    ];
  }
  return [];
}

function flagBigFile(d: DiffBlock, full: string | null): MessFlag[] {
  if (!full) return [];
  const lines = countLines(full);
  if (lines > 800) {
    return [
      {
        rule: 'file-too-long',
        label: `file > 800 lines`,
        reason: `File is ${lines} lines (CLAUDE.md target: ≤800). Consider splitting.`,
        file: d.file,
        severity: 'info',
      },
    ];
  }
  return [];
}

const RULES: Array<(d: DiffBlock, full: string | null) => MessFlag[]> = [
  flagFnTooLong,
  flagInlineCss,
  flagDebugLeftover,
  flagAnyType,
  flagBigFile,
];

export function detectMess(s: TurnSummary, fileContents: Map<string, string>): MessFlag[] {
  const flags: MessFlag[] = [];
  for (const d of s.diffs) {
    const full = fileContents.get(d.file) ?? null;
    for (const rule of RULES) {
      try {
        flags.push(...rule(d, full));
      } catch {
        // never let a flaky regex break the pipeline
      }
    }
  }
  // Dedupe by rule+file (one rule per file per turn).
  const seen = new Set<string>();
  return flags.filter((f) => {
    const k = `${f.rule}::${f.file}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
