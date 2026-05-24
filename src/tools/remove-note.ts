import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import type { NoteBlock, QuillDelta, TripPlan } from "../types.js";
import { findDaySectionByDate, submitOp } from "./shared.js";

export const removeNoteInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove from."),
  text: z
    .string()
    .optional()
    .describe("Substring to match against note content (case-insensitive). One of text, position, or empty must be provided."),
  position: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based position of the note within the day (requires 'day' to be set). Targets by index rather than content."),
  empty: z
    .boolean()
    .optional()
    .describe("If true, matches notes that are empty or contain only whitespace/emojis. Useful for cleaning up blank notes."),
  day: z
    .string()
    .optional()
    .describe(
      "Day to search. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Required for position mode. Optional for text/empty modes.",
    ),
};

export const removeNoteDescription = `
Removes a note block from a Wanderlog trip. Three targeting modes:

1. text — match by substring (case-insensitive). Original behavior.
2. position — target the Nth note (1-based) in a specific day. Requires 'day'. Useful when
   you know the position from get_day_blocks or get_trip output.
3. empty — match notes with no meaningful text content (empty, whitespace-only, or emoji-only).
   Useful for cleaning up blank notes that can't be targeted by text substring.

Exactly one of text, position, or empty must be provided.
If multiple notes match (text or empty mode), a list is returned without deleting.
`.trim();

type Args = {
  trip_key: string;
  text?: string;
  position?: number;
  empty?: boolean;
  day?: string;
};

export type NoteMatch = {
  sectionIndex: number;
  blockIndex: number;
  plainText: string;
  block: NoteBlock;
};

export function extractDeltaText(delta: QuillDelta | undefined): string {
  const ops = delta?.ops ?? [];
  return ops.map((op) => (typeof op.insert === "string" ? op.insert : "")).join("");
}

export function extractPlainText(block: NoteBlock): string {
  return extractDeltaText(block.text);
}

export function findNoteMatches(trip: TripPlan, query: string, day?: string): NoteMatch[] {
  const lowerQuery = query.toLowerCase();
  const sections = trip.itinerary.sections;
  const matches: NoteMatch[] = [];

  let sectionIndices: number[];
  if (day) {
    const resolved = resolveDay(trip, day);
    const found = findDaySectionByDate(trip, resolved.date!);
    if (!found) return [];
    sectionIndices = [found.index];
  } else {
    sectionIndices = Array.from({ length: sections.length }, (_, i) => i);
  }

  for (const sectionIndex of sectionIndices) {
    const section = sections[sectionIndex]!;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
      const block = section.blocks[blockIndex]!;
      if (block.type !== "note") continue;
      const noteBlock = block as NoteBlock;
      const plainText = extractPlainText(noteBlock);
      if (plainText.toLowerCase().includes(lowerQuery)) {
        matches.push({ sectionIndex, blockIndex, plainText, block: noteBlock });
      }
    }
  }

  return matches;
}

function notePreview(plainText: string): string {
  const flat = plainText.replace(/\n/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

function isEmptyOrEmojiOnly(text: string): boolean {
  // Strip whitespace and common emoji ranges
  const stripped = text.replace(/[\s​-‍﻿]/g, "").replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
  return stripped.length === 0;
}

function findEmptyNotes(trip: TripPlan, day?: string): NoteMatch[] {
  const sections = trip.itinerary.sections;
  const matches: NoteMatch[] = [];

  let sectionIndices: number[];
  if (day) {
    const resolved = resolveDay(trip, day);
    const found = findDaySectionByDate(trip, resolved.date!);
    if (!found) return [];
    sectionIndices = [found.index];
  } else {
    sectionIndices = Array.from({ length: sections.length }, (_, i) => i);
  }

  for (const sectionIndex of sectionIndices) {
    const section = sections[sectionIndex]!;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
      const block = section.blocks[blockIndex]!;
      if (block.type !== "note") continue;
      const noteBlock = block as NoteBlock;
      const plainText = extractPlainText(noteBlock);
      if (isEmptyOrEmojiOnly(plainText)) {
        matches.push({ sectionIndex, blockIndex, plainText, block: noteBlock });
      }
    }
  }

  return matches;
}

function findNoteByPosition(trip: TripPlan, position: number, day: string): NoteMatch | null {
  const resolved = resolveDay(trip, day);
  const found = findDaySectionByDate(trip, resolved.date!);
  if (!found) return null;

  const section = found.section;
  let noteCount = 0;
  for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
    const block = section.blocks[blockIndex]!;
    if (block.type !== "note") continue;
    noteCount++;
    if (noteCount === position) {
      const noteBlock = block as NoteBlock;
      return {
        sectionIndex: found.index,
        blockIndex,
        plainText: extractPlainText(noteBlock),
        block: noteBlock,
      };
    }
  }
  return null;
}

export async function removeNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (!args.text && !args.position && !args.empty) {
      return {
        content: [{ type: "text", text: "Provide one of: text (substring), position (1-based), or empty (true)." }],
        isError: true,
      };
    }

    const trip = await ctx.tripCache.get(args.trip_key);
    let target: NoteMatch | null = null;

    // Mode: position
    if (args.position) {
      if (!args.day) {
        return {
          content: [{ type: "text", text: "Position mode requires 'day' to be specified." }],
          isError: true,
        };
      }
      target = findNoteByPosition(trip, args.position, args.day);
      if (!target) {
        return {
          content: [{ type: "text", text: "No note at position " + args.position + " in day \"" + args.day + "\"." }],
          isError: true,
        };
      }
    }
    // Mode: empty
    else if (args.empty) {
      const matches = findEmptyNotes(trip, args.day);
      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: "No empty notes found" + (args.day ? " in day \"" + args.day + "\"" : "") + "." }],
          isError: true,
        };
      }
      if (matches.length > 1) {
        const lines = matches
          .slice(0, 5)
          .map((m, i) => {
            const preview = m.plainText.trim() || "(empty)";
            const section = trip.itinerary.sections[m.sectionIndex]!;
            const dayLabel = section.date || section.heading || "unscheduled";
            return "  " + (i + 1) + ". [" + dayLabel + " pos " + (m.blockIndex + 1) + '] "' + preview + '"';
          })
          .join("\n");
        return {
          content: [{ type: "text", text: matches.length + " empty notes found:\n" + lines + "\n\nAdd 'day' filter or use 'position' mode to target a specific one." }],
          isError: true,
        };
      }
      target = matches[0]!;
    }
    // Mode: text (original)
    else if (args.text) {
      const matches = findNoteMatches(trip, args.text, args.day);
      if (matches.length === 0) {
        throw new WanderlogNotFoundError("Note", args.text);
      }
      if (matches.length > 1) {
        const lines = matches
          .slice(0, 5)
          .map((m, i) => "  " + (i + 1) + '. "' + notePreview(m.plainText) + '"')
          .join("\n");
        const suffix = matches.length > 5 ? "\n  (" + (matches.length - 5) + " more...)" : "";
        return {
          content: [{ type: "text", text: '"' + args.text + '" matches ' + matches.length + " notes:\n" + lines + suffix + "\n\nUse a more specific substring, or use position mode." }],
          isError: true,
        };
      }
      target = matches[0]!;
    }

    if (!target) {
      return { content: [{ type: "text", text: "No note targeted." }], isError: true };
    }

    const { sectionIndex, blockIndex, block, plainText } = target;
    const ops: Json0Op[] = [
      { p: ["itinerary", "sections", sectionIndex, "blocks", blockIndex], ld: block },
    ];

    await submitOp(ctx, args.trip_key, ops);

    const preview = plainText.trim() ? notePreview(plainText) : "(empty note)";
    return { content: [{ type: "text", text: 'Removed note "' + preview + '" from "' + trip.title + '".' }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : "Unexpected error: " + (err as Error).message;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
