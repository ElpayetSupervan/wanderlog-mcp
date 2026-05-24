import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import { isChecklistBlock } from "../types.js";
import type { ChecklistBlock, Section } from "../types.js";
import { findDaySectionByDate, generateBlockId, submitOp } from "./shared.js";

export const editChecklistInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the checklist."),
  title: z
    .string()
    .min(1)
    .describe("Substring to match against checklist title (case-insensitive)."),
  day: z
    .string()
    .optional()
    .describe("Optional day filter. Accepts 'day 2', 'May 4', or ISO date."),
  add_items: z
    .array(z.string())
    .optional()
    .describe("Items to append to the checklist."),
  remove_items: z
    .array(z.string())
    .optional()
    .describe("Substrings of items to remove (case-insensitive match)."),
  check_items: z
    .array(z.string())
    .optional()
    .describe("Substrings of items to mark as checked."),
  uncheck_items: z
    .array(z.string())
    .optional()
    .describe("Substrings of items to mark as unchecked."),
};

export const editChecklistDescription = `
Edits an existing checklist in a Wanderlog trip. Supports adding items, removing items,
checking items, and unchecking items — all in a single call.

Matches the checklist by title substring. If multiple checklists match, returns a list.
Item matching for remove/check/uncheck is case-insensitive substring.
`.trim();

type Args = {
  trip_key: string;
  title: string;
  day?: string;
  add_items?: string[];
  remove_items?: string[];
  check_items?: string[];
  uncheck_items?: string[];
};

function extractItemText(item: { text?: { ops?: Array<{ insert?: string }> } }): string {
  return (item.text?.ops ?? [])
    .map((op) => (typeof op.insert === "string" ? op.insert : ""))
    .join("")
    .trim();
}

function findChecklist(
  sections: Section[],
  query: string,
  day: string | undefined,
  trip: any,
): { sectionIndex: number; blockIndex: number; block: ChecklistBlock }[] {
  const lowerQuery = query.toLowerCase();
  const matches: { sectionIndex: number; blockIndex: number; block: ChecklistBlock }[] = [];

  let sectionIndices: number[];
  if (day) {
    const resolved = resolveDay(trip, day);
    const found = findDaySectionByDate(trip, resolved.date!);
    if (!found) return [];
    sectionIndices = [found.index];
  } else {
    sectionIndices = Array.from({ length: sections.length }, (_, i) => i);
  }

  for (const si of sectionIndices) {
    const section = sections[si]!;
    for (let bi = 0; bi < section.blocks.length; bi++) {
      const block = section.blocks[bi]!;
      if (!isChecklistBlock(block)) continue;
      if ((block.title ?? "").toLowerCase().includes(lowerQuery)) {
        matches.push({ sectionIndex: si, blockIndex: bi, block });
      }
    }
  }
  return matches;
}

export async function editChecklist(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const matches = findChecklist(trip.itinerary.sections, args.title, args.day, trip);

    if (matches.length === 0) {
      throw new WanderlogNotFoundError("Checklist", args.title);
    }
    if (matches.length > 1) {
      const lines = matches
        .slice(0, 5)
        .map((m, i) => `  ${i + 1}. "${m.block.title ?? "(untitled)"}" (${m.block.items.length} items)`)
        .join("\n");
      return {
        content: [{ type: "text", text: `Multiple checklists match "${args.title}":\n${lines}\n\nUse a more specific title.` }],
        isError: true,
      };
    }

    const { sectionIndex, blockIndex, block } = matches[0]!;
    const basePath = ["itinerary", "sections", sectionIndex, "blocks", blockIndex];
    const ops: Json0Op[] = [];
    const actions: string[] = [];

    // Remove items (process in reverse to keep indices stable)
    if (args.remove_items?.length) {
      const indicesToRemove: number[] = [];
      for (const query of args.remove_items) {
        const lower = query.toLowerCase();
        for (let i = 0; i < block.items.length; i++) {
          if (extractItemText(block.items[i]!).toLowerCase().includes(lower)) {
            if (!indicesToRemove.includes(i)) indicesToRemove.push(i);
          }
        }
      }
      indicesToRemove.sort((a, b) => b - a);
      for (const idx of indicesToRemove) {
        ops.push({ p: [...basePath, "items", idx], ld: block.items[idx] });
      }
      if (indicesToRemove.length) actions.push(`removed ${indicesToRemove.length} item(s)`);
    }

    // Check/uncheck items
    if (args.check_items?.length) {
      let count = 0;
      for (const query of args.check_items) {
        const lower = query.toLowerCase();
        for (let i = 0; i < block.items.length; i++) {
          const item = block.items[i]!;
          if (!item.checked && extractItemText(item).toLowerCase().includes(lower)) {
            ops.push({ p: [...basePath, "items", i, "checked"], od: false, oi: true });
            count++;
          }
        }
      }
      if (count) actions.push(`checked ${count} item(s)`);
    }

    if (args.uncheck_items?.length) {
      let count = 0;
      for (const query of args.uncheck_items) {
        const lower = query.toLowerCase();
        for (let i = 0; i < block.items.length; i++) {
          const item = block.items[i]!;
          if (item.checked && extractItemText(item).toLowerCase().includes(lower)) {
            ops.push({ p: [...basePath, "items", i, "checked"], od: true, oi: false });
            count++;
          }
        }
      }
      if (count) actions.push(`unchecked ${count} item(s)`);
    }

    // Add items (after removes to avoid index issues)
    if (args.add_items?.length) {
      const currentLength = block.items.length - (ops.filter(o => "ld" in o).length);
      for (let i = 0; i < args.add_items.length; i++) {
        const newItem = {
          id: generateBlockId(),
          checked: false,
          text: { ops: [{ insert: `${args.add_items[i]}\n` }] },
        };
        ops.push({ p: [...basePath, "items", currentLength + i], li: newItem });
      }
      actions.push(`added ${args.add_items.length} item(s)`);
    }

    if (ops.length === 0) {
      return {
        content: [{ type: "text", text: "No changes specified (add_items, remove_items, check_items, or uncheck_items required)." }],
        isError: true,
      };
    }

    await submitOp(ctx, args.trip_key, ops);

    const title = block.title ?? "(untitled)";
    return {
      content: [{ type: "text", text: `Updated checklist "${title}": ${actions.join(", ")}.` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
