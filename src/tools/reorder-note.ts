import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { findNoteMatches } from "./remove-note.js";
import { submitOp } from "./shared.js";

export const reorderNoteInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the note."),
  text: z
    .string()
    .min(1)
    .describe("Substring to match the note content (case-insensitive)."),
  day: z
    .string()
    .optional()
    .describe("Optional day to narrow the search."),
  position: z
    .union([
      z.enum(["up", "down", "first", "last"]),
      z.number().int().min(1),
    ])
    .describe(
      "Where to move within the day: 'up', 'down', 'first', 'last', or a 1-based position.",
    ),
};

export const reorderNoteDescription = `
Changes the position of a note within its current day/section. Does NOT move between days —
use wanderlog_move_note for that.

Accepts 'up', 'down', 'first', 'last', or a 1-based position number.
`.trim();

type Args = {
  trip_key: string;
  text: string;
  day?: string;
  position: "up" | "down" | "first" | "last" | number;
};

function notePreview(plainText: string): string {
  const flat = plainText.replace(/\n/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

export async function reorderNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const matches = findNoteMatches(trip, args.text, args.day);

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

    const { sectionIndex, blockIndex } = matches[0]!;
    const section = trip.itinerary.sections[sectionIndex]!;
    const blockCount = section.blocks.length;

    let targetIndex: number;
    if (args.position === "up") {
      targetIndex = Math.max(0, blockIndex - 1);
    } else if (args.position === "down") {
      targetIndex = Math.min(blockCount - 1, blockIndex + 1);
    } else if (args.position === "first") {
      targetIndex = 0;
    } else if (args.position === "last") {
      targetIndex = blockCount - 1;
    } else {
      targetIndex = Math.min(Math.max(0, args.position - 1), blockCount - 1);
    }

    if (targetIndex === blockIndex) {
      return {
        content: [{ type: "text", text: "Note is already at that position. No change needed." }],
      };
    }

    const ops: Json0Op[] = [
      { p: ["itinerary", "sections", sectionIndex, "blocks", blockIndex], lm: targetIndex },
    ];

    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [{ type: "text", text: `Moved note "${notePreview(matches[0]!.plainText)}" to position ${targetIndex + 1}.` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
