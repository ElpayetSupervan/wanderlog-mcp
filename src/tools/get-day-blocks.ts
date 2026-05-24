import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import { resolveDay } from "../resolvers/day.js";
import { isChecklistBlock, isPlaceBlock } from "../types.js";
import type { Block, ChecklistBlock, NoteBlock, PlaceBlock, Section } from "../types.js";
import { findDaySectionByDate } from "./shared.js";

export const getDayBlocksInputSchema = {
  trip_key: z.string().min(1).describe("The trip to inspect."),
  day: z
    .string()
    .min(1)
    .describe("Day to list blocks for. Accepts 'day 2', 'May 4', or ISO date."),
};

export const getDayBlocksDescription = `
Returns all blocks (places, notes, checklists, flights, trains, etc.) for a specific day in a
Wanderlog trip, with stable block IDs, types, positions, and content summaries.

Use this for auditing a day's content. Also includes expenses linked to each place block.
`.trim();

type Args = {
  trip_key: string;
  day: string;
};

type ExpenseEntry = {
  id: number;
  amount: { amount: number; currencyCode: string };
  category: string;
  description: string;
  date: string;
  blockId?: number;
};

function extractText(block: { text?: { ops?: Array<{ insert?: string }> } }): string {
  const ops = block.text?.ops ?? [];
  return ops.map((op) => (typeof op.insert === "string" ? op.insert : "")).join("").trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function formatBlock(block: Block, position: number, expenses: ExpenseEntry[]): string {
  const lines: string[] = [];
  const prefix = `  [${position}] id=${block.id} type=${block.type}`;

  if (isPlaceBlock(block)) {
    const pb = block as PlaceBlock;
    const note = extractText(pb);
    const timeParts: string[] = [];
    if (pb.startTime) {
      timeParts.push(pb.startTime);
      if (pb.endTime) timeParts.push(pb.endTime);
    }
    const timeStr = timeParts.length > 0 ? " | " + timeParts.join("-") : "";
    lines.push(prefix + ' | "' + pb.place.name + '"' + timeStr);
    if (note) {
      lines.push('        note: "' + truncate(note, 80) + '"');
    }
    if (pb.hotel) {
      lines.push("        hotel: " + pb.hotel.checkIn + " -> " + pb.hotel.checkOut);
    }
    const linked = expenses.filter((e) => e.blockId === block.id);
    for (const e of linked) {
      lines.push("        expense: " + e.amount.currencyCode + " " + e.amount.amount + " | " + e.category + ' | "' + e.description + '"');
    }
  } else if (block.type === "note") {
    const text = extractText(block as NoteBlock);
    lines.push(prefix + ' | "' + truncate(text, 80) + '"');
  } else if (isChecklistBlock(block)) {
    const cb = block as ChecklistBlock;
    const title = cb.title || "(untitled)";
    const itemCount = cb.items.length;
    lines.push(prefix + ' | "' + title + '" (' + itemCount + " items)");
    const shown = cb.items.slice(0, 5);
    for (const item of shown) {
      const itemText = extractText(item);
      const check = item.checked ? "[x]" : "[ ]";
      lines.push("        " + check + " " + itemText);
    }
    if (itemCount > 5) {
      lines.push("        ... (" + (itemCount - 5) + " more)");
    }
  } else if (block.type === "flight") {
    const fb = block as Record<string, unknown>;
    const info = fb.flightInfo as Record<string, unknown> | undefined;
    const airlineObj = info?.airline as Record<string, unknown> | undefined;
    const airline = String(airlineObj?.iata || "");
    const num = info?.number != null ? String(info.number) : "";
    lines.push(prefix + " | " + airline + " " + num);
  } else if (block.type === "train") {
    const tb = block as Record<string, unknown>;
    const depPlace = (tb.depart as Record<string, unknown>)?.place as Record<string, unknown> | undefined;
    const arrPlace = (tb.arrive as Record<string, unknown>)?.place as Record<string, unknown> | undefined;
    const depName = String(depPlace?.name || "?");
    const arrName = String(arrPlace?.name || "?");
    lines.push(prefix + " | " + depName + " -> " + arrName);
  } else {
    lines.push(prefix);
  }

  return lines.join("\n");
}

export async function getDayBlocks(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const resolved = resolveDay(trip, args.day);
    const found = findDaySectionByDate(trip, resolved.date!);

    if (!found) {
      return {
        content: [{ type: "text", text: 'Day "' + args.day + '" not found in "' + trip.title + '".' }],
        isError: true,
      };
    }

    const section = found.section;
    const budget = (trip.itinerary as Record<string, unknown>).budget as
      | Record<string, unknown>
      | undefined;
    const expenses = (budget?.expenses as ExpenseEntry[] | undefined) ?? [];

    if (section.blocks.length === 0) {
      return {
        content: [{ type: "text", text: "Day " + resolved.date + ' in "' + trip.title + '" has no blocks.' }],
      };
    }

    const heading = section.heading || resolved.date!;
    const header = "Day " + resolved.date + ' -- "' + heading + '" (' + section.blocks.length + " blocks):";
    const blockLines = section.blocks.map((block, i) => formatBlock(block, i + 1, expenses));

    return {
      content: [{ type: "text", text: header + "\n" + blockLines.join("\n") }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : "Unexpected error: " + (err as Error).message;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
