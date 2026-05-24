import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { Block, Section, TrainBlock } from "../types.js";
import { submitOp } from "./shared.js";

export const removeTrainInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove from."),
  train_ref: z
    .string()
    .min(1)
    .describe(
      "Reference to the train: carrier, station name, or ordinal ('1st train', 'last train').",
    ),
};

export const removeTrainDescription = `
Removes a train/transit block from a Wanderlog trip by matching carrier or station names
(case-insensitive). Supports ordinals ('1st train', 'last train').
`.trim();

type Args = {
  trip_key: string;
  train_ref: string;
};

function isTrainBlock(block: Block): block is TrainBlock {
  return block.type === "train";
}

function trainLabel(block: TrainBlock): string {
  const dep = block.depart?.place?.name ?? "";
  const arr = block.arrive?.place?.name ?? "";
  if (dep || arr) return `${dep} → ${arr}`;
  return block.carrier ?? "train";
}

function trainMatchesQuery(block: TrainBlock, query: string): boolean {
  const lower = query.toLowerCase();
  const searchable = [
    block.carrier,
    block.depart?.place?.name,
    block.arrive?.place?.name,
    block.confirmationNumber,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return searchable.includes(lower);
}

export async function removeTrain(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);

    const allTrains: { sectionIndex: number; blockIndex: number; block: TrainBlock }[] = [];
    for (let si = 0; si < trip.itinerary.sections.length; si++) {
      const section = trip.itinerary.sections[si]!;
      if (section.type !== "transit") continue;
      for (let bi = 0; bi < section.blocks.length; bi++) {
        const block = section.blocks[bi]!;
        if (isTrainBlock(block)) allTrains.push({ sectionIndex: si, blockIndex: bi, block });
      }
    }

    if (allTrains.length === 0) {
      throw new WanderlogNotFoundError("Train", args.train_ref);
    }

    const ordinalMatch = /^(\d+)(?:st|nd|rd|th)\s+train$/i.exec(args.train_ref);
    const lastMatch = /^last\s+train$/i.test(args.train_ref);

    let matches: typeof allTrains;
    if (ordinalMatch) {
      const idx = parseInt(ordinalMatch[1]!, 10) - 1;
      matches = idx >= 0 && idx < allTrains.length ? [allTrains[idx]!] : [];
    } else if (lastMatch) {
      matches = [allTrains[allTrains.length - 1]!];
    } else {
      matches = allTrains.filter((t) => trainMatchesQuery(t.block, args.train_ref));
    }

    if (matches.length === 0) {
      throw new WanderlogNotFoundError("Train", args.train_ref);
    }
    if (matches.length > 1) {
      const lines = matches
        .slice(0, 5)
        .map((m, i) => `  ${i + 1}. ${trainLabel(m.block)}`)
        .join("\n");
      return {
        content: [{ type: "text", text: `"${args.train_ref}" matches ${matches.length} trains:\n${lines}\n\nUse ordinal or more specific info.` }],
        isError: true,
      };
    }

    const { sectionIndex, blockIndex, block } = matches[0]!;
    const ops: Json0Op[] = [
      { p: ["itinerary", "sections", sectionIndex, "blocks", blockIndex], ld: block as unknown as Record<string, unknown> },
    ];
    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [{ type: "text", text: `Removed train "${trainLabel(block)}" from "${trip.title}".` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
