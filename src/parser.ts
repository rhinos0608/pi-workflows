/**
 * Deterministic directive parser.
 *
 * Pure, side-effect-free. Never evaluates args, never loads workflow
 * definitions. Directive args are metadata that command handlers consume
 * via `{{arg}}` string substitution only.
 */
import { MAX_DIRECTIVES } from "./constants.ts";

export interface ParsedInput {
  tokens: InputToken[];
  /** Count of recognized directives (≤ MAX_DIRECTIVES). */
  directiveCount: number;
}

export type InputToken =
  | { type: "prose"; text: string }
  | { type: "directive"; name: string; args: string; raw: string };

/**
 * Grammar (deterministic, single left-to-right pass, no LLM):
 *
 *   input      ::= token* EOF
 *   token      ::= directive | prose_run
 *   directive  ::= "/" name args_tail?
 *                 where name ∈ knownNames
 *                 and directive-count < MAX_DIRECTIVES
 *   name       ::= [a-zA-Z0-9_-]+
 *   prose_run  ::= any chars not starting a recognized directive
 *
 *   args_tail  ::= everything up to (but not including) the next
 *                  "/" name-in-known | EOF, minus connector clauses
 *   connector  ::= ( "," | ";" )? ( "and then" | "then" | "afterwards" |
 *                  "followed by" ) (case-insensitive, word-bounded),
 *                  plus any connective clause between two connectors in
 *                  the same span (e.g. ", then loop until … and then")
 *
 * Deterministic arg rules:
 *   1. Explicit inline forms: "/name: …" (colon) and "/name to …" start
 *      the args directly (colon adheres with no space).
 *   2. A tail that starts with a connector clause yields "" — the clause
 *      is connective prose between dispatches, never args. So in
 *        Do X, then /review, then loop until reviewers satisfied and
 *        then /verify
 *      "review" and "verify" both get args "" and the leading prose is
 *      "Do X, then ".
 *   3. Otherwise args = the tail up to the first connector; a trailing
 *      connector (and anything after it) is connective prose and is
 *      omitted — "/wf-a inspect cache, then /other" keeps "inspect cache".
 *   4. Ordinary positional args are preserved verbatim when no connector
 *      delimits them.
 *   5. The directive ceiling is enforced by the same isDirectiveStart
 *      predicate used for dispatch, so a connector before the 9th "/name"
 *      never promotes it into a dispatch: it stays prose (cap semantics
 *      unchanged; connector text still never lands in the 8th args).
 *   6. An unknown "/foo" is prose preserved verbatim.
 */
/** Connector words; alternatives ordered so "and then" wins over "then". */
const CONNECTOR = /(?:and\s+then|then|afterwards|followed\s+by)\b/i;
const CONNECTOR_AT_START = /^(?:and\s+then|then|afterwards|followed\s+by)\b/i;

/** Colon and "to" inline-arg introducers. */
const COLON_ARG = /^:\s*/;
const TO_ARG = /^to\b/i;

/**
 * Strip connector clauses from a directive args tail (see grammar rules).
 * Pure. Only strips the finite connector set — ordinary positional args
 * pass through untouched when no connector delimits them.
 */
function stripConnectors(argsRaw: string): string {
  // Explicit inline forms first: "/name: …" and "/name to …".
  let t = argsRaw.trim().replace(COLON_ARG, "").replace(TO_ARG, "").trim();
  // Commas/semicolons may surround a connector.
  t = t.replace(/^[,;]\s*/, "");
  if (t === "") return "";
  if (CONNECTOR_AT_START.test(t)) return ""; // whole tail is a connector clause
  const at = t.search(CONNECTOR);
  if (at === -1) return t;
  // Trim the trailing connector along with any comma/semicolon/space.
  return t.slice(0, at).replace(/[\s,;]+$/, "");
}

export function parseDirectives(text: string, knownNames: ReadonlySet<string>): ParsedInput {
  const tokens: InputToken[] = [];
  let directiveCount = 0;
  let prose: string | null = null;

  function isDirectiveStart(text: string, i: number): { at: number; name: string } | null {
    if (text[i] !== "/" || i + 1 >= text.length) return null;
    let j = i + 1;
    while (j < text.length && /[a-zA-Z0-9_-]/.test(text[j])) j++;
    if (j === i + 1) return null; // "/" not followed by a name char
    const name = text.slice(i + 1, j);
    if (!knownNames.has(name)) return null;
    return { at: j, name };
  }

  let i = 0;
  const len = text.length;
  while (i < len) {
    if (directiveCount < MAX_DIRECTIVES) {
      const start = isDirectiveStart(text, i);
      if (start) {
        if (prose !== null) {
          tokens.push({ type: "prose", text: prose });
          prose = null;
        }
        // args_tail: everything up to the next recognized directive start.
        let j = start.at;
        while (j < len) {
          const next = isDirectiveStart(text, j);
          if (next) break;
          j++;
        }
        const argsRaw = text.slice(start.at, j);
        const args = stripConnectors(argsRaw);
        const raw = text.slice(i, j).trimEnd();
        tokens.push({ type: "directive", name: start.name, args, raw });
        directiveCount++;
        i = j;
        continue;
      }
    }
    // Not a directive here: accumulate prose. (Unknown /foo and everything
    // past the directive ceiling goes through this branch verbatim.)
    if (prose === null) prose = "";
    prose += text[i];
    i++;
  }
  if (prose !== null) {
    tokens.push({ type: "prose", text: prose });
  }
  return { tokens, directiveCount };
}