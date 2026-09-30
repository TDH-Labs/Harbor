/**
 * printable.ts — making untrusted text safe to show a person, and spotting text that
 * cannot be.
 *
 * Anything a collaborator can write — a skill's text, a file NAME in a shared folder —
 * can reach an operator's terminal or an agent's context. Raw, it can redraw the
 * screen, rewind a line so later text overwrites earlier text, reorder what is
 * displayed, or carry characters nobody sees (which an LLM still reads).
 */

/**
 * Characters that make what a person reads differ from what is there, or carry text
 * nobody reads: C0/C1 controls (a terminal escape can redraw the screen and hide
 * lines), soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width space,
 * left/right marks, bidirectional overrides and isolates, invisible operators, Hangul
 * filler, the BOM, and the Unicode Tags and variation-selector-supplement blocks
 * (invisible text an LLM still reads). Tab and newline are allowed in TEXT;
 * zero-width joiner/non-joiner are left alone (emoji and several scripts need them).
 */
const HIDDEN_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const HIDDEN_G = new RegExp(HIDDEN_RE.source, "gu");
/** A carriage return that is not half of CRLF rewinds the line and lets later text overwrite earlier text. */
const LONE_CR_RE = /\r(?!\n)/;

/** Does `s` contain a character that can hide or rewrite what a reader sees? */
export const hasHidden = (s: string): boolean => HIDDEN_RE.test(s) || LONE_CR_RE.test(s);

/** Text made safe to print: every hidden character (and a lone CR) is shown as `\u{…}`. */
export function visible(s: string): string {
  return s.replace(HIDDEN_G, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`).replace(/\r(?!\n)/g, "\\r");
}

/**
 * A PATH made safe to print. A name may not span lines or carry a tab, so those are
 * escaped too — otherwise a file named `x\n===== SKILL.md =====` forges a section
 * header in a listing.
 */
export function visiblePath(s: string): string {
  return visible(s).replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");
}

/** Does a file NAME contain anything that cannot be shown faithfully on one line? */
export const hasHiddenInName = (s: string): boolean => hasHidden(s) || /[\n\t\r]/.test(s);
