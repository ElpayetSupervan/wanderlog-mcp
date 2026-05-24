import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { Block, FlightBlock, Section } from "../types.js";
import { submitOp } from "./shared.js";

export const removeFlightInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove from."),
  flight_ref: z
    .string()
    .min(1)
    .describe(
      "Reference to the flight: airline name, IATA code, flight number, airport, or ordinal ('1st flight', 'last flight').",
    ),
};

export const removeFlightDescription = `
Removes a flight block from a Wanderlog trip by matching against airline, flight number,
or airport names (case-insensitive). Supports ordinals ('1st flight', 'last flight').
`.trim();

type Args = {
  trip_key: string;
  flight_ref: string;
};

function isFlightBlock(block: Block): block is FlightBlock {
  return block.type === "flight";
}

function flightLabel(block: FlightBlock): string {
  const parts: string[] = [];
  if (block.flightInfo?.airline?.iata) parts.push(block.flightInfo.airline.iata);
  if (block.flightInfo?.number) parts.push(String(block.flightInfo.number));
  if (parts.length === 0) {
    const dep = block.depart?.airport?.name ?? block.depart?.airport?.iata ?? "";
    const arr = block.arrive?.airport?.name ?? block.arrive?.airport?.iata ?? "";
    if (dep || arr) return `${dep} → ${arr}`;
    return "flight";
  }
  return parts.join(" ");
}

function flightMatchesQuery(block: FlightBlock, query: string): boolean {
  const lower = query.toLowerCase();
  const searchable = [
    block.flightInfo?.airline?.name,
    block.flightInfo?.airline?.iata,
    block.flightInfo?.number != null ? String(block.flightInfo.number) : null,
    block.depart?.airport?.name,
    block.depart?.airport?.iata,
    block.arrive?.airport?.name,
    block.arrive?.airport?.iata,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return searchable.includes(lower);
}

export async function removeFlight(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);

    // Collect all flight blocks across sections
    const allFlights: { sectionIndex: number; blockIndex: number; block: FlightBlock }[] = [];
    for (let si = 0; si < trip.itinerary.sections.length; si++) {
      const section = trip.itinerary.sections[si]!;
      if (section.type !== "flights") continue;
      for (let bi = 0; bi < section.blocks.length; bi++) {
        const block = section.blocks[bi]!;
        if (isFlightBlock(block)) allFlights.push({ sectionIndex: si, blockIndex: bi, block });
      }
    }

    if (allFlights.length === 0) {
      throw new WanderlogNotFoundError("Flight", args.flight_ref);
    }

    // Ordinal matching
    const ordinalMatch = /^(\d+)(?:st|nd|rd|th)\s+flight$/i.exec(args.flight_ref);
    const lastMatch = /^last\s+flight$/i.test(args.flight_ref);

    let matches: typeof allFlights;
    if (ordinalMatch) {
      const idx = parseInt(ordinalMatch[1]!, 10) - 1;
      matches = idx >= 0 && idx < allFlights.length ? [allFlights[idx]!] : [];
    } else if (lastMatch) {
      matches = [allFlights[allFlights.length - 1]!];
    } else {
      matches = allFlights.filter((f) => flightMatchesQuery(f.block, args.flight_ref));
    }

    if (matches.length === 0) {
      throw new WanderlogNotFoundError("Flight", args.flight_ref);
    }
    if (matches.length > 1) {
      const lines = matches
        .slice(0, 5)
        .map((m, i) => `  ${i + 1}. ${flightLabel(m.block)}`)
        .join("\n");
      return {
        content: [{ type: "text", text: `"${args.flight_ref}" matches ${matches.length} flights:\n${lines}\n\nUse ordinal ('1st flight') or more specific info.` }],
        isError: true,
      };
    }

    const { sectionIndex, blockIndex, block } = matches[0]!;
    const ops: Json0Op[] = [
      { p: ["itinerary", "sections", sectionIndex, "blocks", blockIndex], ld: block as unknown as Record<string, unknown> },
    ];
    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [{ type: "text", text: `Removed flight "${flightLabel(block)}" from "${trip.title}".` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
