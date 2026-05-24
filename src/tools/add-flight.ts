import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { Section } from "../types.js";
import { generateBlockId, requireUserId, submitOp } from "./shared.js";

export const addFlightInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add the flight to."),
  airline: z.string().optional().describe("Airline name (e.g. 'Air France')."),
  airline_iata: z.string().max(3).optional().describe("Airline IATA code (e.g. 'AF')."),
  flight_number: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Flight number (e.g. '1234' or 1234)."),
  depart_airport: z.string().optional().describe("Departure airport name or IATA code."),
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
  arrive_airport: z.string().optional().describe("Arrival airport name or IATA code."),
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
  traveler_names: z.array(z.string()).optional().describe("Names of travelers on this flight."),
};

export const addFlightDescription = `
Adds a flight block to a Wanderlog trip. The flight is placed in the trip's "Flights" section.

Provide as much detail as available — airline, flight number, airports, dates/times,
confirmation number, and traveler names.
`.trim();

type Args = {
  trip_key: string;
  airline?: string;
  airline_iata?: string;
  flight_number?: string | number;
  depart_airport?: string;
  depart_date?: string;
  depart_time?: string;
  arrive_airport?: string;
  arrive_date?: string;
  arrive_time?: string;
  confirmation_number?: string;
  traveler_names?: string[];
};

function findFlightsSection(sections: Section[]): { index: number; section: Section } | null {
  for (let i = 0; i < sections.length; i++) {
    if (sections[i]!.type === "flights") return { index: i, section: sections[i]! };
  }
  return null;
}

export async function addFlight(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    requireUserId(ctx);
    const trip = await ctx.tripCache.get(args.trip_key);

    const flightSection = findFlightsSection(trip.itinerary.sections);
    if (!flightSection) {
      return {
        content: [
          {
            type: "text",
            text: `No "Flights" section found in "${trip.title}". Open the trip in Wanderlog and add a flight manually first to create the section, then retry.`,
          },
        ],
        isError: true,
      };
    }

    const block: Record<string, unknown> = {
      id: generateBlockId(),
      type: "flight",
      flightInfo: {
        airline: { name: args.airline ?? null, iata: args.airline_iata ?? null },
        number: args.flight_number ?? null,
      },
      depart: {
        date: args.depart_date ?? null,
        time: args.depart_time ?? null,
        airport: { name: args.depart_airport ?? null, iata: null, cityName: null },
      },
      arrive: {
        date: args.arrive_date ?? null,
        time: args.arrive_time ?? null,
        airport: { name: args.arrive_airport ?? null, iata: null, cityName: null },
      },
      confirmationNumber: args.confirmation_number ?? null,
      travelerNames: args.traveler_names ?? [],
    };

    const insertIndex = flightSection.section.blocks.length;
    const ops: Json0Op[] = [
      {
        p: ["itinerary", "sections", flightSection.index, "blocks", insertIndex],
        li: block,
      },
    ];

    await submitOp(ctx, args.trip_key, ops);

    const label = [args.airline_iata, args.flight_number].filter(Boolean).join(" ") ||
      [args.depart_airport, "→", args.arrive_airport].filter(Boolean).join(" ") ||
      "flight";
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
