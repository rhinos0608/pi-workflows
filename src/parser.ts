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
 * Grammar (deterministic, single left-to-right pass):
 *
 *   input      ::= token* EOF
 *   token      ::= directive | prose_run
 *   directive  ::= "/" name (" " args_tail)?
 *                 where name ∈ knownNames
 *                 and directive-count < MAX_DIRECTIVES
 *   args_tail  ::= everything up to (but not including) the next
 *                  "/" name-in-known | EOF
 *   name       ::= [a-zA-Z0-9_-]+
 *   prose_run  ::= any chars not starting a recognized directive
 *
 * After MAX_DIRECTIVES directives, every remaining "/name" (even a known
 * one) is prose. An unknown "/foo" is prose preserved verbatim.
 */
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
        const args = argsRaw.trim();
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