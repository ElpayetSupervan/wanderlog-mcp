import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock } from "../types.js";
import { findDaySectionByDate, submitOp } from "./shared.js";

export const movePlaceInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the place."),
  place_ref: z
    .string()
    .min(1)
    .describe(
      "Natural-language reference to the place to move. Same syntax as wanderlog_remove_place: name, ordinal prefix, day filter.",
    ),
  to_day: z
    .string()
    .min(1)
    .describe(
      "Target day to move the place to. Accepts 'day 3', 'May 6', or ISO '2026-05-06'.",
    ),
  position: z
    .enum(["start", "end"])
    .optional()
    .describe("Where in the target day to insert. Defaults to 'end'."),
};

export const movePlaceDescription = `
Moves a place from its current position to a different day in the same trip.

Uses the same natural-language place reference as wanderlog_remove_place (name, ordinal
prefixes, day filters). The place is removed from its current section and inserted at the
start or end of the target day section.

If the reference is ambiguous, returns candidates without making changes.
`.trim();

type Args = {
  trip_key: string;
  place_ref: string;
  to_day: string;
  position?: "start" | "end";
};

export async function movePlace(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const result = resolvePlaceRef(trip, args.place_ref);

    if (result.kind === "none") {
      return {
        content: [{ type: "text", text: `No place found matching "${args.place_ref}".` }],
        isError: true,
      };
    }

    if (result.kind === "ambiguous") {
      const lines = result.candidates
        .slice(0, 10)
        .map((c, i) => {
          const name = isPlaceBlock(c.block)
            ? c.block.place.name
            : `${c.block.type} block`;
          return `  ${i + 1}. ${name}`;
        })
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `"${args.place_ref}" matches ${result.candidates.length} places:\n${lines}\n\nUse an ordinal prefix or day filter to narrow down.`,
          },
        ],
        isError: true,
      };
    }

    const { sectionIndex: fromSectionIndex, blockIndex: fromBlockIndex, block } =
      result.match;

    const resolved = resolveDay(trip, args.to_day);
    const targetSection = findDaySectionByDate(trip, resolved.date!);
    if (!targetSection) {
      return {
        content: [
          { type: "text", text: `Day "${args.to_day}" not found in trip "${trip.title}".` },
        ],
        isError: true,
      };
    }

    const toSectionIndex = targetSection.index;

    if (fromSectionIndex === toSectionIndex) {
      return {
        content: [
          { type: "text", text: "Place is already in that day. No change needed." },
        ],
      };
    }

    const insertAt =
      args.position === "start" ? 0 : targetSection.section.blocks.length;

    const ops: Json0Op[] = [
      {
        p: ["itinerary", "sections", fromSectionIndex, "blocks", fromBlockIndex],
        ld: block as unknown as Record<string, unknown>,
      },
      {
        p: ["itinerary", "sections", toSectionIndex, "blocks", insertAt],
        li: block as unknown as Record<string, unknown>,
      },
    ];

    await submitOp(ctx, args.trip_key, ops);

    const placeName = isPlaceBlock(block) ? block.place.name : `${block.type} block`;
    return {
      content: [
        {
          type: "text",
          text: `Moved "${placeName}" to ${resolved.date} (${args.position ?? "end"}) in "${trip.title}".`,
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
