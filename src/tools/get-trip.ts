import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import { formatTrip } from "../formatters/trip-summary.js";
import { resolveDay } from "../resolvers/day.js";

export const getTripInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe(
      "The unique trip key from wanderlog_list_trips (e.g. 'vzyrsyhgxvonvxcz'). Required.",
    ),
  day: z
    .string()
    .optional()
    .describe(
      "Optional filter to a single day. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to return the whole trip.",
    ),
  response_format: z
    .enum(["concise", "detailed"])
    .default("concise")
    .describe(
      "Output verbosity. 'concise' (default) is a readable summary grouped by day; 'detailed' adds addresses, phone numbers, ratings, check-in dates, expenses under each place, note positions, and orphan expenses.",
    ),
  include_orphans: z
    .boolean()
    .optional()
    .describe("Show orphan expenses (linked to deleted places) at the end. Default: true in detailed, false in concise."),
};

export const getTripDescription = `
Returns the itinerary for one Wanderlog trip: the hotels list, the "places to visit" list, and
each day's scheduled places.

Use concise format for summarizing or answering questions about a trip in natural language.
Use detailed format when the user asks for specific info like addresses, phone numbers, or
hotel check-in/out dates.

If you don't know the trip_key, call wanderlog_list_trips first to find it.
`.trim();

type Args = {
  trip_key: string;
  day?: string;
  response_format?: "concise" | "detailed";
  include_orphans?: boolean;
};

export async function getTrip(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const format = args.response_format ?? "concise";
    const daySection = args.day ? resolveDay(trip, args.day) : undefined;
    const includeOrphans = args.include_orphans ?? (format === "detailed");
    const text = formatTrip(trip, format, daySection, { includeOrphans });
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const e =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: e }], isError: true };
  }
}
