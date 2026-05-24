import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { isPlaceBlock } from "../types.js";
import type { Block, PlaceBlock, Section } from "../types.js";
import { findHotelsSection, submitOp } from "./shared.js";

export const removeHotelInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove from."),
  hotel_ref: z
    .string()
    .min(1)
    .describe(
      "Natural-language reference to the hotel. Can be a name ('Park Hyatt'), partial match ('Hyatt'), or ordinal ('1st hotel', 'last hotel').",
    ),
};

export const removeHotelDescription = `
Removes a hotel block from a Wanderlog trip by matching the hotel name.

Hotels are place blocks stored in the "Hotels" section. The match is case-insensitive.
If multiple hotels match, a list is returned — supply a more specific name or use an
ordinal prefix ('1st', '2nd', 'last').
`.trim();

type Args = {
  trip_key: string;
  hotel_ref: string;
};

type HotelMatch = {
  sectionIndex: number;
  blockIndex: number;
  block: PlaceBlock;
  name: string;
};

function findHotelMatches(
  sections: Section[],
  hotelSectionIndex: number,
  query: string,
): HotelMatch[] {
  const section = sections[hotelSectionIndex]!;
  const lowerQuery = query.toLowerCase();
  const matches: HotelMatch[] = [];

  const ordinalMatch = /^(\d+)(?:st|nd|rd|th)\s+hotel$/i.exec(query);
  const lastMatch = /^last\s+hotel$/i.test(query);

  if (ordinalMatch || lastMatch) {
    const hotels: HotelMatch[] = [];
    for (let i = 0; i < section.blocks.length; i++) {
      const block = section.blocks[i]!;
      if (isPlaceBlock(block) && block.hotel) {
        hotels.push({
          sectionIndex: hotelSectionIndex,
          blockIndex: i,
          block,
          name: block.place.name,
        });
      }
    }
    if (lastMatch && hotels.length > 0) return [hotels[hotels.length - 1]!];
    if (ordinalMatch) {
      const idx = parseInt(ordinalMatch[1]!, 10) - 1;
      if (idx >= 0 && idx < hotels.length) return [hotels[idx]!];
    }
    return [];
  }

  for (let i = 0; i < section.blocks.length; i++) {
    const block = section.blocks[i]!;
    if (!isPlaceBlock(block) || !block.hotel) continue;
    if (block.place.name.toLowerCase().includes(lowerQuery)) {
      matches.push({
        sectionIndex: hotelSectionIndex,
        blockIndex: i,
        block,
        name: block.place.name,
      });
    }
  }

  return matches;
}

export async function removeHotel(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const hotelSection = findHotelsSection(trip);

    if (!hotelSection) {
      throw new WanderlogNotFoundError("Hotels section", args.trip_key);
    }

    const matches = findHotelMatches(
      trip.itinerary.sections,
      hotelSection.index,
      args.hotel_ref,
    );

    if (matches.length === 0) {
      throw new WanderlogNotFoundError("Hotel", args.hotel_ref);
    }

    if (matches.length > 1) {
      const lines = matches
        .slice(0, 5)
        .map((m, i) => `  ${i + 1}. ${m.name}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `"${args.hotel_ref}" matches ${matches.length} hotels:\n${lines}\n\nCall again with a more specific name or ordinal ('1st hotel', '2nd hotel').`,
          },
        ],
        isError: true,
      };
    }

    const { sectionIndex, blockIndex, block, name } = matches[0]!;
    const ops: Json0Op[] = [
      {
        p: ["itinerary", "sections", sectionIndex, "blocks", blockIndex],
        ld: block as unknown as Record<string, unknown>,
      },
    ];

    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [{ type: "text", text: `Removed hotel "${name}" from "${trip.title}".` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
