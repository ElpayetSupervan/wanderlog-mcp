import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import { findDaySectionByDate, submitOp } from "./shared.js";
import { findNoteMatches, extractPlainText } from "./remove-note.js";

export const moveNoteInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the note."),
  text: z
    .string()
    .min(1)
    .describe("Substring to match the note content (case-insensitive)."),
  from_day: z
    .string()
    .optional()
    .describe("Optional source day to narrow the search."),
  to_day: z
    .string()
    .min(1)
    .describe("Target day. Accepts 'day 3', 'May 6', or ISO date."),
  position: z
    .enum(["start", "end"])
    .optional()
    .describe("Where in the target day to insert. Defaults to 'end'."),
};

export const moveNoteDescription = `
Moves a note from its current position to a different day in the same trip.

Matches the note by text substring (case-insensitive). If multiple match, returns previews.
`.trim();

type Args = {
  trip_key: string;
  text: string;
  from_day?: string;
  to_day: string;
  position?: "start" | "end";
};

function notePreview(plainText: string): string {
  const flat = plainText.replace(/\n/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

export async function moveNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const matches = findNoteMatches(trip, args.text, args.from_day);

    if (matches.length === 0) {
      return {
        content: [{ type: "text", text: `No note matching "${args.text}" found.` }],
        isError: true,
      };
    }
    if (matches.length > 1) {
      const lines = matches
        .slice(0, 5)
        .map((m, i) => `  ${i + 1}. "${notePreview(m.plainText)}"`)
        .join("\n");
      return {
        content: [{ type: "text", text: `"${args.text}" matches ${matches.length} notes:\n${lines}\n\nUse a more specific substring.` }],
        isError: true,
      };
    }

    const { sectionIndex: fromSectionIndex, blockIndex: fromBlockIndex, block, plainText } = matches[0]!;

    const resolved = resolveDay(trip, args.to_day);
    const targetSection = findDaySectionByDate(trip, resolved.date!);
    if (!targetSection) {
      return {
        content: [{ type: "text", text: `Day "${args.to_day}" not found in trip.` }],
        isError: true,
      };
    }

    if (fromSectionIndex === targetSection.index) {
      return {
        content: [{ type: "text", text: "Note is already in that day. No change needed." }],
      };
    }

    const insertAt = args.position === "start" ? 0 : targetSection.section.blocks.length;

    const ops: Json0Op[] = [
      { p: ["itinerary", "sections", fromSectionIndex, "blocks", fromBlockIndex], ld: block },
      { p: ["itinerary", "sections", targetSection.index, "blocks", insertAt], li: block },
    ];

    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [{ type: "text", text: `Moved note "${notePreview(plainText)}" to ${resolved.date}.` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
