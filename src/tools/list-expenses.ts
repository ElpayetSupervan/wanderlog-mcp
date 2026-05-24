import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import { resolveDay } from "../resolvers/day.js";
import { isPlaceBlock } from "../types.js";
import type { Block, Section, TripPlan } from "../types.js";
import { findDaySectionByDate } from "./shared.js";

export const listExpensesInputSchema = {
  trip_key: z.string().min(1).describe("The trip to list expenses for."),
  day: z
    .string()
    .optional()
    .describe("Optional day filter. Accepts 'day 2', 'May 4', or ISO date."),
  place_ref: z
    .string()
    .optional()
    .describe("Optional place name to filter expenses by (case-insensitive substring match)."),
  category: z
    .string()
    .optional()
    .describe("Optional category filter (e.g. 'food', 'lodging', 'sightseeing')."),
};

export const listExpensesDescription = `
Lists all expenses in a Wanderlog trip's budget, with optional filters by day, place, or category.

Returns each expense with its ID, amount, currency, category, description, linked place name,
and date. Also shows a total per currency at the bottom.
`.trim();

type Args = {
  trip_key: string;
  day?: string;
  place_ref?: string;
  category?: string;
};

type ExpenseEntry = {
  id: number;
  amount: { amount: number; currencyCode: string };
  category: string;
  description: string;
  date: string;
  blockId?: number;
  associatedDate?: string;
};

function findBlockById(sections: Section[], blockId: number): Block | null {
  for (const section of sections) {
    for (const block of section.blocks) {
      if (block.id === blockId) return block;
    }
  }
  return null;
}

export async function listExpenses(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const budget = (trip.itinerary as Record<string, unknown>).budget as
      | Record<string, unknown>
      | undefined;
    const expenses = (budget?.expenses as ExpenseEntry[] | undefined) ?? [];

    if (expenses.length === 0) {
      return {
        content: [{ type: "text", text: `No expenses in "${trip.title}".` }],
      };
    }

    let filtered = expenses;

    // Filter by day
    if (args.day) {
      const resolved = resolveDay(trip, args.day);
      filtered = filtered.filter(
        (e) => e.associatedDate === resolved.date || e.date === resolved.date,
      );
    }

    // Filter by place
    if (args.place_ref) {
      const lowerRef = args.place_ref.toLowerCase();
      filtered = filtered.filter((e) => {
        if (!e.blockId) return false;
        const block = findBlockById(trip.itinerary.sections, e.blockId);
        if (!block || !isPlaceBlock(block)) return false;
        return block.place.name.toLowerCase().includes(lowerRef);
      });
    }

    // Filter by category
    if (args.category) {
      const lowerCat = args.category.toLowerCase();
      filtered = filtered.filter((e) => e.category.toLowerCase() === lowerCat);
    }

    if (filtered.length === 0) {
      return {
        content: [{ type: "text", text: `No expenses match the given filters in "${trip.title}".` }],
      };
    }

    // Format output
    const lines: string[] = [];
    const totals = new Map<string, number>();

    for (const e of filtered) {
      const placeName = e.blockId
        ? (() => {
            const block = findBlockById(trip.itinerary.sections, e.blockId);
            return block && isPlaceBlock(block) ? block.place.name : `block #${e.blockId}`;
          })()
        : "(unlinked)";

      const currency = e.amount.currencyCode;
      lines.push(
        `  - [${e.id}] ${currency} ${e.amount.amount} | ${e.category} | "${e.description}" | ${placeName} | ${e.date}`,
      );

      totals.set(currency, (totals.get(currency) ?? 0) + e.amount.amount);
    }

    const totalLine = Array.from(totals.entries())
      .map(([cur, sum]) => `${cur} ${sum.toFixed(2)}`)
      .join(", ");

    const header = `Expenses in "${trip.title}" (${filtered.length}/${expenses.length}):`;
    const footer = `\nTotal: ${totalLine}`;

    return {
      content: [{ type: "text", text: `${header}\n${lines.join("\n")}${footer}` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
