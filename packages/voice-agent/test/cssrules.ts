import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * **The page's stylesheet, parsed once, for the guards that read it.**
 *
 * This is a second copy of `packages/web/test/cssrules.ts`, which parses the
 * APP's sheet — and the copy is deliberate rather than lazy. That module's
 * `css` constant is bound to `packages/web/src/styles.css`, and its ten callers
 * are the app's design guards; teaching it to read this package's sheet would
 * mean passing a path through guards that do not want one. The alternative —
 * importing across packages out of another package's `test/` directory — is the
 * coupling this package was created to remove.
 *
 * The reason the parser is not a regex is worth keeping with it: the shared
 * one-liner, `([^{}]+)\{([^}]*)\}`, cannot nest, so for every `@media` or
 * `@supports` block an author writes it folds the at-rule's prelude and the
 * FIRST rule inside it into a single pseudo-rule. Nine rules of the app's sheet
 * were invisible to every check that works per-selector before that was fixed.
 * This sheet has `@supports`, `@media`, `@position-try` and `@keyframes` blocks
 * in it, so the brace-counting walk matters here too.
 */

export const css = readFileSync(path.join(import.meta.dirname, "..", "src", "voice.css"), "utf8");

export interface Rule {
  /** The selector list as written, whitespace collapsed. */
  selector: string;
  /** The declarations between its braces. */
  body: string;
  /** The `@media`/`@supports` preludes it sits inside, outermost first. Empty
   *  for a rule at the top level. */
  at: string[];
}

/** The sheet with comments blanked, newlines preserved so a line number in a
 *  failure still points at the real line. */
export function withoutComments(text: string = css): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Every rule in the sheet, including the ones inside at-rules. */
export function rules(text: string = css): Rule[] {
  const src = withoutComments(text);
  const out: Rule[] = [];
  const stack: string[] = [];
  let head = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = head.trim().replace(/\s+/g, " ");
      head = "";
      // An at-rule opens a scope; anything else opens a rule whose body runs
      // to its matching brace.
      if (prelude.startsWith("@") && !prelude.startsWith("@font-face")) {
        stack.push(prelude);
        continue;
      }
      let depth = 1;
      let j = i + 1;
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
      }
      out.push({ selector: prelude, body: src.slice(i + 1, j - 1), at: [...stack] });
      i = j - 1;
    } else if (ch === "}") {
      stack.pop();
      head = "";
    } else {
      head += ch;
    }
  }
  return out;
}
