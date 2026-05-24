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
  include_orphans: z
    .boolean()
    .optional()
    .describe("Include expenses whose linked place no longer exists in the trip (default: true)."),
  response_format: z
    .enum(["concise", "detailed"])
    .optional()
    .describe("Output format: 'concise' (one line per expense) or 'detailed' (full object). Default: 'concise'."),
};

export const listExpensesDescription = `
Lists all expenses in a Wanderlog trip's budget, with optional filters by day, place, or category.

Key features:
- Detects orphan expenses (linked to a place that no longer exists) and marks them [ORPHAN].
- Returns stable expense IDs that can be used with remove_expense and update_expense.
- Shows totals per currency at the bottom.

Use include_orphans=true (default) to audit broken references after remove_place operations.
`.trim();

type Args = {
  trip_key: string;
  day?: string;
  place_ref?: string;
  category?: string;
  include_orphans?: boolean;
  response_format?: "concise" | "detailed";
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

function isOrphan(expense: ExpenseEntry, sections: Section[]): boolean {
  if (!expense.blockId) return true;
  const block = findBlockById(sections, expense.blockId);
  return block === null;
}

function getPlaceName(expense: ExpenseEntry, sections: Section[]): string {
  if (!expense.blockId) return "(unlinked)";
  const block = findBlockById(sections, expense.blockId);
  if (!block) return "(deleted pin)";
  if (isPlaceBlock(block)) return block.place.name;
  return "block #" + expense.blockId;
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
        content: [{ type: "text", text: "No expenses in \"" + trip.title + "\"." }],
      };
    }

    const includeOrphans = args.include_orphans !== false;
    const format = args.response_format || "concise";

    let filtered: { index: number; expense: ExpenseEntry; orphan: boolean }[] = expenses.map(
      (e, i) => ({ index: i, expense: e, orphan: isOrphan(e, trip.itinerary.sections) }),
    );

    // Filter orphans
    if (!includeOrphans) {
      filtered = filtered.filter((e) => !e.orphan);
    }

    // Filter by day
    if (args.day) {
      const resolved = resolveDay(trip, args.day);
      filtered = filtered.filter(
        (e) => e.expense.associatedDate === resolved.date || e.expense.date === resolved.date,
      );
    }

    // Filter by place
    if (args.place_ref) {
      const lowerRef = args.place_ref.toLowerCase();
      filtered = filtered.filter((e) => {
        if (!e.expense.blockId) return false;
        const block = findBlockById(trip.itinerary.sections, e.expense.blockId);
        if (!block || !isPlaceBlock(block)) return false;
        return block.place.name.toLowerCase().includes(lowerRef);
      });
    }

    // Filter by category
    if (args.category) {
      const lowerCat = args.category.toLowerCase();
      filtered = filtered.filter((e) => e.expense.category.toLowerCase() === lowerCat);
    }

    if (filtered.length === 0) {
      return {
        content: [{ type: "text", text: "No expenses match the given filters in \"" + trip.title + "\"." }],
      };
    }

    const orphanCount = filtered.filter((e) => e.orphan).length;
    const totals = new Map<string, number>();
    for (const e of filtered) {
      const cur = e.expense.amount.currencyCode;
      totals.set(cur, (totals.get(cur) ?? 0) + e.expense.amount.amount);
    }

    let output: string;

    if (format === "detailed") {
      const items = filtered.map((e) => ({
        id: e.expense.id,
        index: e.index,
        amount: e.expense.amount.amount,
        currency: e.expense.amount.currencyCode,
        category: e.expense.category,
        description: e.expense.description,
        place_name: getPlaceName(e.expense, trip.itinerary.sections),
        place_id: e.expense.blockId ?? null,
        day: e.expense.associatedDate || e.expense.date,
        is_orphan: e.orphan,
      }));
      output = JSON.stringify({ total: Object.fromEntries(totals), count: filtered.length, orphan_count: orphanCount, expenses: items }, null, 2);
    } else {
      const lines: string[] = [];
      for (const e of filtered) {
        const exp = e.expense;
        const orphanTag = e.orphan ? " [ORPHAN]" : "";
        const placeName = getPlaceName(exp, trip.itinerary.sections);
        const cur = exp.amount.currencyCode;
        lines.push(
          "  [" + exp.id + "] " + cur + " " + exp.amount.amount + " " + exp.category + ' — "' + exp.description + '" @ ' + placeName + " (" + (exp.associatedDate || exp.date) + ")" + orphanTag,
        );
      }
      const totalLine = Array.from(totals.entries())
        .map(([cur, sum]) => cur + " " + sum.toFixed(2))
        .join(", ");
      const header = "Expenses in \"" + trip.title + "\" (" + filtered.length + "/" + expenses.length + ")" + (orphanCount > 0 ? " — " + orphanCount + " orphan(s)" : "") + ":";
      output = header + "\n" + lines.join("\n") + "\n\nTotal: " + totalLine;
    }

    return { content: [{ type: "text", text: output }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : "Unexpected error: " + (err as Error).message;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
