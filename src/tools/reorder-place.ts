import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock } from "../types.js";
import { submitOp } from "./shared.js";

export const reorderPlaceInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the place."),
  place_ref: z
    .string()
    .min(1)
    .describe("Natural-language reference to the place to reorder (same syntax as remove_place)."),
  position: z
    .union([
      z.enum(["up", "down", "first", "last"]),
      z.number().int().min(0),
    ])
    .describe(
      "Where to move: 'up' (one slot earlier), 'down' (one slot later), 'first', 'last', or a 0-based index.",
    ),
};

export const reorderPlaceDescription = `
Changes the position of a place within its current day/section. Does NOT move between days —
use wanderlog_move_place for that.

Accepts 'up', 'down', 'first', 'last', or a numeric 0-based index.
If the reference is ambiguous, returns candidates without making changes.
`.trim();

type Args = {
  trip_key: string;
  place_ref: string;
  position: "up" | "down" | "first" | "last" | number;
};

export async function reorderPlace(
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
          const name = isPlaceBlock(c.block) ? c.block.place.name : `${c.block.type} block`;
          return `  ${i + 1}. ${name}`;
        })
        .join("\n");
      return {
        content: [{ type: "text", text: `"${args.place_ref}" matches multiple:\n${lines}\n\nUse an ordinal or day filter.` }],
        isError: true,
      };
    }

    const { sectionIndex, blockIndex, block, section } = result.match;
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
      targetIndex = Math.min(Math.max(0, args.position), blockCount - 1);
    }

    if (targetIndex === blockIndex) {
      return {
        content: [{ type: "text", text: "Place is already at that position. No change needed." }],
      };
    }

    // OT move = remove + insert. After removal, target indices shift.
    const adjustedTarget = targetIndex > blockIndex ? targetIndex : targetIndex;
    const ops: Json0Op[] = [
      { p: ["itinerary", "sections", sectionIndex, "blocks", blockIndex], lm: adjustedTarget },
    ];

    await submitOp(ctx, args.trip_key, ops);

    const placeName = isPlaceBlock(block) ? block.place.name : `${block.type} block`;
    return {
      content: [{ type: "text", text: `Moved "${placeName}" to position ${targetIndex + 1} in its section.` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
