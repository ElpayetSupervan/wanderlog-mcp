import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { Section } from "../types.js";
import { generateBlockId, requireUserId, submitOp } from "./shared.js";

export const addTrainInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add the train to."),
  carrier: z.string().optional().describe("Train carrier/operator (e.g. 'SNCF', 'JR East', 'Renfe')."),
  depart_station: z.string().optional().describe("Departure station name."),
  depart_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Departure date (YYYY-MM-DD)."),
  depart_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe("Departure time (HH:mm)."),
  arrive_station: z.string().optional().describe("Arrival station name."),
  arrive_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Arrival date (YYYY-MM-DD)."),
  arrive_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe("Arrival time (HH:mm)."),
  confirmation_number: z.string().optional().describe("Booking confirmation number."),
  traveler_names: z.array(z.string()).optional().describe("Names of travelers."),
};

export const addTrainDescription = `
Adds a train/transit block to a Wanderlog trip. Placed in the trip's "Transit" section.

Provide carrier, stations, dates/times, confirmation number, and traveler names as available.
`.trim();

type Args = {
  trip_key: string;
  carrier?: string;
  depart_station?: string;
  depart_date?: string;
  depart_time?: string;
  arrive_station?: string;
  arrive_date?: string;
  arrive_time?: string;
  confirmation_number?: string;
  traveler_names?: string[];
};

function findTransitSection(sections: Section[]): { index: number; section: Section } | null {
  for (let i = 0; i < sections.length; i++) {
    if (sections[i]!.type === "transit") return { index: i, section: sections[i]! };
  }
  return null;
}

export async function addTrain(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    requireUserId(ctx);
    const trip = await ctx.tripCache.get(args.trip_key);

    const transitSection = findTransitSection(trip.itinerary.sections);
    if (!transitSection) {
      return {
        content: [
          {
            type: "text",
            text: `No "Transit" section found in "${trip.title}". Open the trip in Wanderlog and add transit manually first to create the section, then retry.`,
          },
        ],
        isError: true,
      };
    }

    const block: Record<string, unknown> = {
      id: generateBlockId(),
      type: "train",
      carrier: args.carrier ?? null,
      depart: {
        date: args.depart_date ?? null,
        time: args.depart_time ?? null,
        place: { name: args.depart_station ?? null, formatted_address: null },
      },
      arrive: {
        date: args.arrive_date ?? null,
        time: args.arrive_time ?? null,
        place: { name: args.arrive_station ?? null, formatted_address: null },
      },
      confirmationNumber: args.confirmation_number ?? null,
      travelerNames: args.traveler_names ?? [],
    };

    const insertIndex = transitSection.section.blocks.length;
    const ops: Json0Op[] = [
      {
        p: ["itinerary", "sections", transitSection.index, "blocks", insertIndex],
        li: block,
      },
    ];

    await submitOp(ctx, args.trip_key, ops);

    const label = [args.depart_station, "→", args.arrive_station].filter(Boolean).join(" ") ||
      args.carrier || "train";
    return {
      content: [{ type: "text", text: `Added ${label} to "${trip.title}".` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
