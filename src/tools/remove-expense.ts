import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock } from "../types.js";
import type { Block, Section } from "../types.js";
import { submitOp } from "./shared.js";

export const removeExpenseInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the expense."),
  expense_id: z
    .number()
    .optional()
    .describe("Stable expense ID (from list_expenses). Takes priority over other modes."),
  description: z
    .string()
    .optional()
    .describe("Substring to match against expense description (case-insensitive)."),
  place_ref: z
    .string()
    .optional()
    .describe("Remove ALL expenses linked to this place (natural-language reference). Useful for cleanup after remove_place."),
  day: z
    .string()
    .optional()
    .describe("Optional day filter to narrow results."),
  amount: z
    .number()
    .optional()
    .describe("Optional amount filter for disambiguation."),
  category: z
    .string()
    .optional()
    .describe("Optional category filter for disambiguation."),
};

export const removeExpenseDescription = `
Removes one or more expenses from a Wanderlog trip's budget.

Three mutually exclusive targeting modes (priority order):
1. expense_id — targets a single expense by stable ID (from list_expenses). Most precise.
2. description — substring match (case-insensitive). Returns disambiguation list if multiple match.
3. place_ref — removes ALL expenses linked to a specific place. Useful for bulk cleanup after
   remove_place (cascading delete of orphaned expenses).

Additional filters (day, amount, category) narrow results in modes 2 and 3.

If multiple expenses match in mode 2, a numbered list is returned without deleting anything.
In mode 3 (place_ref), ALL matching expenses are deleted in one call (no confirmation needed —
the intent to bulk-delete is explicit).
`.trim();

type Args = {
  trip_key: string;
  expense_id?: number;
  description?: string;
  place_ref?: string;
  day?: string;
  amount?: number;
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

function applyFilters(
  matches: { index: number; expense: ExpenseEntry }[],
  args: Args,
): { index: number; expense: ExpenseEntry }[] {
  let result = matches;
  if (args.day) {
    result = result.filter(
      (m) => m.expense.associatedDate === args.day || m.expense.date === args.day,
    );
  }
  if (args.amount !== undefined) {
    result = result.filter((m) => m.expense.amount.amount === args.amount);
  }
  if (args.category) {
    const lowerCat = args.category.toLowerCase();
    result = result.filter((m) => m.expense.category.toLowerCase() === lowerCat);
  }
  return result;
}

export async function removeExpense(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (!args.expense_id && !args.description && !args.place_ref) {
      return {
        content: [{ type: "text", text: "At least one of expense_id, description, or place_ref must be provided." }],
        isError: true,
      };
    }

    const trip = await ctx.tripCache.get(args.trip_key);
    const budget = (trip.itinerary as Record<string, unknown>).budget as
      | Record<string, unknown>
      | undefined;
    const expenses = (budget?.expenses as ExpenseEntry[] | undefined) ?? [];

    if (expenses.length === 0) {
      return {
        content: [{ type: "text", text: "No expenses in this trip." }],
        isError: true,
      };
    }

    let toDelete: { index: number; expense: ExpenseEntry }[] = [];

    // Mode 1: expense_id (highest priority)
    if (args.expense_id !== undefined) {
      for (let i = 0; i < expenses.length; i++) {
        if (expenses[i]!.id === args.expense_id) {
          toDelete = [{ index: i, expense: expenses[i]! }];
          break;
        }
      }
      if (toDelete.length === 0) {
        throw new WanderlogNotFoundError("Expense", "id=" + args.expense_id);
      }
    }
    // Mode 2: description match
    else if (args.description) {
      const lowerQuery = args.description.toLowerCase();
      let matches: { index: number; expense: ExpenseEntry }[] = [];
      for (let i = 0; i < expenses.length; i++) {
        if (expenses[i]!.description.toLowerCase().includes(lowerQuery)) {
          matches.push({ index: i, expense: expenses[i]! });
        }
      }
      matches = applyFilters(matches, args);

      if (matches.length === 0) {
        throw new WanderlogNotFoundError("Expense", args.description);
      }
      if (matches.length > 1) {
        const lines = matches
          .slice(0, 8)
          .map((m, i) => {
            const e = m.expense;
            return "  " + (i + 1) + '. [' + e.id + '] "' + e.description + '" — ' + e.amount.currencyCode + " " + e.amount.amount + " (" + e.date + ")";
          })
          .join("\n");
        const suffix = matches.length > 8 ? "\n  (" + (matches.length - 8) + " more...)" : "";
        return {
          content: [{ type: "text", text: '"' + args.description + '" matches ' + matches.length + " expenses:\n" + lines + suffix + "\n\nUse expense_id for precision, or add day/amount/category filters." }],
          isError: true,
        };
      }
      toDelete = matches;
    }
    // Mode 3: place_ref (bulk delete)
    else if (args.place_ref) {
      const result = resolvePlaceRef(trip, args.place_ref);
      let targetBlockId: number | null = null;

      if (result.kind === "none") {
        // Place not found — might be deleted. Try to find orphan expenses by name match
        const lowerRef = args.place_ref.toLowerCase();
        let matches: { index: number; expense: ExpenseEntry }[] = [];
        for (let i = 0; i < expenses.length; i++) {
          const e = expenses[i]!;
          // Check if expense description or any metadata matches
          if (e.blockId) {
            const block = findBlockById(trip.itinerary.sections, e.blockId);
            if (block === null) {
              // Orphan — include if description loosely matches
              if (e.description.toLowerCase().includes(lowerRef)) {
                matches.push({ index: i, expense: e });
              }
            }
          }
        }
        matches = applyFilters(matches, args);
        if (matches.length === 0) {
          throw new WanderlogNotFoundError("Place or orphan expenses", args.place_ref);
        }
        toDelete = matches;
      } else if (result.kind === "ambiguous") {
        const lines = result.candidates.slice(0, 5).map((c, i) => {
          const name = isPlaceBlock(c.block) ? c.block.place.name : "block #" + c.block.id;
          return "  " + (i + 1) + ". " + name;
        }).join("\n");
        return {
          content: [{ type: "text", text: 'Multiple places match "' + args.place_ref + '":\n' + lines + "\n\nUse a more specific reference." }],
          isError: true,
        };
      } else {
        targetBlockId = result.match.block.id;
        let matches: { index: number; expense: ExpenseEntry }[] = [];
        for (let i = 0; i < expenses.length; i++) {
          if (expenses[i]!.blockId === targetBlockId) {
            matches.push({ index: i, expense: expenses[i]! });
          }
        }
        matches = applyFilters(matches, args);
        if (matches.length === 0) {
          const placeName = isPlaceBlock(result.match.block) ? result.match.block.place.name : "block";
          return {
            content: [{ type: "text", text: "No expenses linked to \"" + placeName + "\"." }],
          };
        }
        toDelete = matches;
      }
    }

    // Delete in reverse index order to keep indices stable
    toDelete.sort((a, b) => b.index - a.index);
    const ops: Json0Op[] = toDelete.map((m) => ({
      p: ["itinerary", "budget", "expenses", m.index],
      ld: m.expense,
    }));

    await submitOp(ctx, args.trip_key, ops);

    if (toDelete.length === 1) {
      const e = toDelete[0]!.expense;
      return {
        content: [{ type: "text", text: 'Removed expense "' + e.description + '" (' + e.amount.currencyCode + " " + e.amount.amount + ') from "' + trip.title + '".' }],
      };
    }
    const totalAmount = toDelete.reduce((sum, m) => sum + m.expense.amount.amount, 0);
    const currency = toDelete[0]!.expense.amount.currencyCode;
    return {
      content: [{ type: "text", text: "Removed " + toDelete.length + " expenses (total: " + currency + " " + totalAmount.toFixed(2) + ') from "' + trip.title + '".' }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : "Unexpected error: " + (err as Error).message;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
