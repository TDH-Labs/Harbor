/**
 * room-picker.ts — Interactive multi-select room picker for the CLI.
 *
 * Replaces silent auto-routing at skill-install/skill-room-add time with an
 * explicit confirmation step: list every configured room (with its
 * description) and let the operator pick one or more, rather than a keyword
 * score silently guessing on their behalf. Rooms are not mutually exclusive —
 * a skill can be genuinely useful in more than one (see skills.ts's
 * explicitSkillRooms) — so this is a multi-select, not a single choice.
 *
 * Falls back to the caller's non-interactive path (auto-score, or an explicit
 * --room flag) whenever stdin isn't a TTY — a piped/scripted/CI invocation has
 * no one to prompt, and must never hang waiting for input that will never
 * arrive.
 */
import * as clack from "@clack/prompts";

export interface RoomChoice {
  room: string;
  description: string;
}

/** True when an interactive prompt is possible in the current process. */
export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Prompt for one or more rooms from `choices`. Returns the selected room
 * names, or `null` if the user cancelled (Ctrl+C) — callers should treat null
 * as "abort the operation," not "select nothing." Throws if called when
 * {@link canPrompt} is false; check that first.
 */
export async function pickRooms(
  choices: RoomChoice[],
  options: { message: string; suggested?: string[]; disabledRooms?: string[] } = { message: "Select room(s):" },
): Promise<string[] | null> {
  if (!canPrompt()) {
    throw new Error("pickRooms: not an interactive terminal (check canPrompt() first)");
  }
  if (choices.length === 0) return [];

  const disabled = new Set(options.disabledRooms ?? []);
  const selected = await clack.multiselect<string>({
    message: options.message,
    options: choices.map((c) => ({
      value: c.room,
      label: c.room,
      hint: disabled.has(c.room) ? `${c.description} (already granted)`.trim() : c.description,
      disabled: disabled.has(c.room),
    })),
    initialValues: (options.suggested ?? []).filter((r) => !disabled.has(r)),
    required: true,
  });

  if (clack.isCancel(selected)) return null;
  return selected;
}
