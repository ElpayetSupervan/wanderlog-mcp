import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import { isChecklistBlock } from "../types.js";
import type { ChecklistBlock, Section } from "../types.js";
import { findDaySectionByDate, submitOp } from "./shared.js";

export const removeChecklistInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove from."),
  title: z
    .string()
    .min(1)
    .describe(
      "Substring to match against checklist title (case-insensitive). Examples: 'pre-trip', 'packing', 'visa'.",
    ),
  day: z
    .string()
    .optional()
    .describe(
      "Optional day to search. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to search the entire trip.",
    ),
};

export const removeChecklistDescription = `
Removes a checklist block from a Wanderlog trip by matching its title.

The match is case-insensitive. If multiple checklists match, a list of titles is returned —
supply a more specific substring. Use the optional 'day' filter to limit the search.
`.trim();

type Args = {
  trip_key: string;
  title: string;
  day?: string;
};

type ChecklistMatch = {
  sectionIndex: number;
  blockIndex: number;
  block: ChecklistBlock;
  title: string;
  itemCount: number;
};

function findChecklistMatches(
  sections: Section[],
  query: string,
  day?: string,
  trip?: { itinerary: { sections: Section[] }; startDate: string; endDate: string; days: number },
): ChecklistMatch[] {
  const lowerQuery = query.toLowerCase();
  const matches: ChecklistMatch[] = [];

  let sectionIndices: number[];
  if (day && trip) {
    const resolved = resolveDay(trip as any, day);
    const found = findDaySectionByDate(trip as any, resolved.date!);
    if (!found) return [];
    sectionIndices = [found.index];
  } else {
    sectionIndices = Array.from({ length: sections.length }, (_, i) => i);
  }

  for (const sectionIndex of sectionIndices) {
    const section = sections[sectionIndex]!;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
      const block = section.blocks[blockIndex]!;
      if (!isChecklistBlock(block)) continue;
      const title = block.title ?? "";
      if (title.toLowerCase().includes(lowerQuery)) {
        matches.push({
          sectionIndex,
          blockIndex,
          block,
          title: title || "(untitled)",
          itemCount: block.items.length,
        });
      }
    }
  }

  return matches;
}

export async function removeChecklist(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const matches = findChecklistMatches(
      trip.itinerary.sections,
      args.title,
      args.day,
      trip,
    );

    if (matches.length === 0) {
      throw new WanderlogNotFoundError("Checklist", args.title);
    }

    if (matches.length > 1) {
      const lines = matches
        .slice(0, 5)
        .map((m, i) => `  ${i + 1}. "${m.title}" (${m.itemCount} items)`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `"${args.title}" matches ${matches.length} checklists:\n${lines}\n\nCall again with a more specific title substring.`,
          },
        ],
        isError: true,
      };
    }

    const { sectionIndex, blockIndex, block, title, itemCount } = matches[0]!;
    const ops: Json0Op[] = [
      {
        p: ["itinerary", "sections", sectionIndex, "blocks", blockIndex],
        ld: block as unknown as Record<string, unknown>,
      },
    ];

    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [
        {
          type: "text",
          text: `Removed checklist "${title}" (${itemCount} items) from "${trip.title}".`,
        },
      ],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
