import type {
  Block,
  ChecklistBlock,
  FlightBlock,
  NoteBlock,
  PlaceBlock,
  QuillDelta,
  Section,
  TrainBlock,
  TripPlan,
  TripPlanSummary,
  UnknownBlock,
} from "../types.js";

export type ResponseFormat = "concise" | "detailed";

export type FormatOptions = {
  includeOrphans?: boolean;
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

export function formatTripList(
  trips: TripPlanSummary[],
  format: ResponseFormat,
): string {
  if (trips.length === 0) return "No trips found in this account.";

  if (format === "concise") {
    return trips
      .map((t) => {
        const dates =
          t.startDate && t.endDate ? ` · ${t.startDate} → ${t.endDate}` : "";
        const places = t.placeCount != null ? ` · ${t.placeCount} places` : "";
        return `• ${t.title}${dates}${places} [key: ${t.key}]`;
      })
      .join("\n");
  }

  return trips
    .map((t) => {
      const lines = [
        `Title:    ${t.title}`,
        `Key:      ${t.key}`,
        `Dates:    ${t.startDate ?? "?"} → ${t.endDate ?? "?"}`,
        `Places:   ${t.placeCount ?? 0}`,
      ];
      if (t.user) lines.push(`Owner:    ${t.user.username}`);
      if (t.editedAt) lines.push(`Edited:   ${t.editedAt}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export function formatTrip(
  trip: TripPlan,
  format: ResponseFormat,
  dayFilter?: Section,
  options?: FormatOptions,
): string {
  const expenses = getExpenses(trip);
  const blockIds = getAllBlockIds(trip);

  if (dayFilter) return formatDay(trip, dayFilter, format, expenses);

  const parts: string[] = [formatTripHeader(trip, format)];

  for (const section of trip.itinerary.sections) {
    const rendered = renderSection(section, format, expenses);
    if (rendered) parts.push("", rendered);
  }

  // Orphan expenses section
  if (options?.includeOrphans && expenses.length > 0) {
    const orphans = expenses.filter(
      (e) => !e.blockId || !blockIds.has(e.blockId),
    );
    if (orphans.length > 0) {
      parts.push("", formatOrphanExpenses(orphans));
    }
  }

  return parts.join("\n");
}

function getExpenses(trip: TripPlan): ExpenseEntry[] {
  const budget = (trip.itinerary as Record<string, unknown>).budget as
    | Record<string, unknown>
    | undefined;
  return (budget?.expenses as ExpenseEntry[] | undefined) ?? [];
}

function getAllBlockIds(trip: TripPlan): Set<number> {
  const ids = new Set<number>();
  for (const section of trip.itinerary.sections) {
    for (const block of section.blocks) {
      ids.add(block.id);
    }
  }
  return ids;
}

function formatOrphanExpenses(orphans: ExpenseEntry[]): string {
  const lines = orphans.map((e) => {
    const cur = e.amount.currencyCode;
    const day = e.associatedDate || e.date || "?";
    return `  • [ORPHAN] ${cur} ${e.amount.amount} [${e.category}] — "${e.description}" (id: ${e.id}, was on ${day})`;
  });
  return `📦 ORPHAN EXPENSES (no longer linked to a place):\n${lines.join("\n")}`;
}

function getExpensesForBlock(blockId: number, expenses: ExpenseEntry[]): ExpenseEntry[] {
  return expenses.filter((e) => e.blockId === blockId);
}

function renderSection(section: Section, format: ResponseFormat, expenses: ExpenseEntry[]): string | null {
  if (section.mode === "dayPlan" && section.date) {
    return renderDaySection(section, format, expenses);
  }

  const sectionText = section.text ? quillToPlain(section.text).trim() : "";
  const blockLines = (section.blocks ?? [])
    .map((b) => formatBlockWithExpenses(b, format, expenses))
    .filter(Boolean) as string[];

  if (!sectionText && blockLines.length === 0) return null;

  const icon = sectionIcon(section);
  const heading = section.heading?.trim() || sectionDefaultHeading(section);
  const parts = [`${icon} ${heading}`];
  if (sectionText) parts.push(sectionText);
  if (blockLines.length > 0) {
    parts.push(blockLines.join("\n"));
  }
  return parts.join("\n");
}

function renderDaySection(section: Section, format: ResponseFormat, expenses: ExpenseEntry[]): string {
  const label = formatDayLabel(section);
  if (section.blocks.length === 0) {
    return `📅 ${label}\n  (no plans)`;
  }

  let noteCounter = 0;
  const lines: string[] = [];

  for (const block of section.blocks) {
    if (block.type === "note") {
      noteCounter++;
    }
    const line = formatBlockWithExpenses(block, format, expenses, block.type === "note" ? noteCounter : undefined);
    if (line) lines.push(line);
  }

  return `📅 ${label}\n${lines.join("\n")}`;
}

function formatBlockWithExpenses(
  block: Block,
  format: ResponseFormat,
  expenses: ExpenseEntry[],
  notePosition?: number,
): string | null {
  const mainLine = formatBlockLine(block, format, notePosition);
  if (!mainLine) return null;

  const prefixed = `  • ${mainLine}`;

  // In detailed mode, show expenses under place blocks
  if (format === "detailed" && block.type === "place") {
    const blockExpenses = getExpensesForBlock(block.id, expenses);
    if (blockExpenses.length > 0) {
      const expenseLines = blockExpenses.map((e) => {
        const cur = e.amount.currencyCode;
        return `      💰 ${cur} ${e.amount.amount} [${e.category}] — "${e.description}" (id: ${e.id})`;
      });
      return prefixed + "\n" + expenseLines.join("\n");
    }
  }

  return prefixed;
}

function sectionIcon(section: Section): string {
  switch (section.type) {
    case "hotels":
      return "🏨";
    case "flights":
      return "���";
    case "transit":
      return "🚆";
    case "textOnly":
      return "📝";
    default:
      return "📌";
  }
}

function sectionDefaultHeading(section: Section): string {
  switch (section.type) {
    case "hotels":
      return "Hotels";
    case "flights":
      return "Flights";
    case "transit":
      return "Transit";
    default:
      return "Places";
  }
}

function formatTripHeader(trip: TripPlan, format: ResponseFormat): string {
  const dates = `${trip.startDate} → ${trip.endDate}`;
  const base = `${trip.title} · ${dates} · ${trip.days} days · ${trip.placeCount} places`;
  if (format === "concise") return base;

  const extras: string[] = [base, `Key: ${trip.key}`, `Privacy: ${trip.privacy}`];
  const contributorNames = trip.contributors?.map((c) => c.username).join(", ");
  if (contributorNames) extras.push(`Contributors: ${contributorNames}`);
  return extras.join("\n");
}

function formatDay(
  trip: TripPlan,
  section: Section,
  format: ResponseFormat,
  expenses: ExpenseEntry[],
): string {
  const label = formatDayLabel(section);
  const header = `${trip.title} — ${label}`;
  if (section.blocks.length === 0) {
    return `${header}\n(no plans for this day yet)`;
  }

  let noteCounter = 0;
  const lines: string[] = [];
  for (const block of section.blocks) {
    if (block.type === "note") noteCounter++;
    const line = formatBlockLine(block, format, block.type === "note" ? noteCounter : undefined);
    if (!line) continue;

    let output = `• ${line}`;
    if (format === "detailed" && block.type === "place") {
      const blockExpenses = getExpensesForBlock(block.id, expenses);
      if (blockExpenses.length > 0) {
        const expLines = blockExpenses.map((e) => {
          const cur = e.amount.currencyCode;
          return `    💰 ${cur} ${e.amount.amount} [${e.category}] — "${e.description}" (id: ${e.id})`;
        });
        output += "\n" + expLines.join("\n");
      }
    }
    lines.push(output);
  }
  return `${header}\n${lines.join("\n")}`;
}

/**
 * Renders any block as a single line. Never throws on unknown shapes —
 * falls back to a best-effort description.
 */
export function formatBlockLine(block: Block, format: ResponseFormat, notePosition?: number): string | null {
  try {
    switch (block.type) {
      case "place":
        return formatPlaceBlock(block as PlaceBlock, format);
      case "note":
        return formatNoteBlock(block as NoteBlock, format, notePosition);
      case "checklist":
        return formatChecklistBlock(block as ChecklistBlock, format);
      case "flight":
        return formatFlightBlock(block as FlightBlock, format);
      case "train":
        return formatTrainBlock(block as TrainBlock, format);
      default:
        return formatUnknownBlock(block as UnknownBlock);
    }
  } catch {
    return `${block.type ?? "block"} (malformed)`;
  }
}

function formatPlaceBlock(block: PlaceBlock, format: ResponseFormat): string | null {
  const p = block.place;
  if (!p?.name) return null;

  const time = block.startTime
    ? `${formatTime(block.startTime)}${block.endTime ? `–${formatTime(block.endTime)}` : ""} `
    : "";

  const inlineNote = quillToPlain(block.text).replace(/\s+/g, " ").trim();
  const hasNote = inlineNote.length > 0;

  if (format === "concise") {
    const rating = p.rating ? ` ★${p.rating}` : "";
    const hotel = block.hotel?.checkIn
      ? ` (check-in ${block.hotel.checkIn}, out ${block.hotel.checkOut})`
      : "";
    const note = hasNote
      ? `\n    📝 ${inlineNote.length > 120 ? `${inlineNote.slice(0, 117)}…` : inlineNote}`
      : "";
    return `${time}${p.name}${rating}${hotel}${note}`;
  }

  const parts = [`${time}${p.name}`];
  if (p.rating) parts.push(`★${p.rating} (${p.user_ratings_total ?? 0} reviews)`);
  if (p.types?.length) parts.push(`[${p.types.slice(0, 3).join(", ")}]`);
  if (p.formatted_address) parts.push(p.formatted_address);
  if (p.international_phone_number) parts.push(p.international_phone_number);
  if (block.hotel?.checkIn)
    parts.push(`check-in ${block.hotel.checkIn} → check-out ${block.hotel.checkOut}`);
  if (block.hotel?.confirmationNumber)
    parts.push(`conf. ${block.hotel.confirmationNumber}`);
  if (hasNote) {
    parts.push(`📝 ${inlineNote}`);
  }
  return parts.join(" · ");
}

function formatNoteBlock(block: NoteBlock, format: ResponseFormat, position?: number): string | null {
  const text = quillToPlain(block.text);
  const oneLine = text.replace(/\s+/g, " ").trim();
  const posLabel = position != null ? `[${position}] ` : "";

  if (!oneLine) {
    // Show empty notes in detailed mode so they can be targeted by position
    if (format === "detailed") return `📝 ${posLabel}(empty)`;
    return null;
  }

  if (format === "concise") {
    const truncated = oneLine.length > 200 ? `${oneLine.slice(0, 197)}…` : oneLine;
    return `📝 ${truncated}`;
  }
  return `📝 ${posLabel}${oneLine}`;
}

function formatChecklistBlock(block: ChecklistBlock, format: ResponseFormat): string | null {
  const items = block.items ?? [];
  if (items.length === 0 && !block.title) return null;

  const titlePrefix = block.title ? `${block.title}: ` : "";

  if (format === "concise") {
    const checked = items.filter((i) => i.checked).length;
    const itemPreviews = items
      .slice(0, 5)
      .map((i) => {
        const mark = i.checked ? "[x]" : "[ ]";
        const text = quillToPlain(i.text).replace(/\s+/g, " ").trim();
        return `${mark} ${text || "(empty)"}`;
      });
    const suffix = items.length > 5 ? ` (+${items.length - 5} more)` : "";
    const progress = items.length > 0 ? ` [${checked}/${items.length}]` : "";
    return `☑ ${titlePrefix}${itemPreviews.join(", ")}${suffix}${progress}`;
  }

  const lines = items.map((i) => {
    const mark = i.checked ? "[x]" : "[ ]";
    const text = quillToPlain(i.text).replace(/\s+/g, " ").trim();
    return `  ${mark} ${text || "(empty)"}`;
  });
  const checked = items.filter((i) => i.checked).length;
  const progress = items.length > 0 ? ` [${checked}/${items.length}]` : "";
  return `☑ ${titlePrefix}${progress}\n${lines.join("\n")}`;
}

function formatFlightBlock(block: FlightBlock, format: ResponseFormat): string {
  const airline = block.flightInfo?.airline?.iata ?? block.flightInfo?.airline?.name ?? "";
  const number = block.flightInfo?.number != null ? `${block.flightInfo.number}` : "";
  const flightLabel = [airline, number].filter(Boolean).join(" ").trim() || "Flight";

  const from = formatAirport(block.depart);
  const to = formatAirport(block.arrive);
  const departDate = block.depart?.date ?? "";
  const departTime = block.depart?.time ? ` ${block.depart.time}` : "";

  if (format === "concise") {
    return `✈ ${flightLabel} · ${from} → ${to}${departDate ? ` · ${departDate}${departTime}` : ""}`;
  }
  const parts = [
    `✈ ${flightLabel}`,
    `${from} → ${to}`,
    `${departDate}${departTime} → ${block.arrive?.date ?? ""}${block.arrive?.time ? ` ${block.arrive.time}` : ""}`,
  ];
  if (block.confirmationNumber) parts.push(`conf. ${block.confirmationNumber}`);
  if (block.travelerNames?.length) parts.push(`pax: ${block.travelerNames.join(", ")}`);
  return parts.join(" · ");
}

function formatTrainBlock(block: TrainBlock, format: ResponseFormat): string {
  const carrier = block.carrier ?? "Train";
  const from = block.depart?.place?.name ?? "?";
  const to = block.arrive?.place?.name ?? "?";
  const departDate = block.depart?.date ?? "";
  const departTime = block.depart?.time ? ` ${block.depart.time}` : "";

  if (format === "concise") {
    return `🚆 ${carrier} · ${from} → ${to}${departDate ? ` · ${departDate}${departTime}` : ""}`;
  }
  const parts = [
    `🚆 ${carrier}`,
    `${from} → ${to}`,
    `${departDate}${departTime} → ${block.arrive?.date ?? ""}${block.arrive?.time ? ` ${block.arrive.time}` : ""}`,
  ];
  if (block.confirmationNumber) parts.push(`conf. ${block.confirmationNumber}`);
  return parts.join(" �� ");
}

function formatUnknownBlock(block: UnknownBlock): string {
  return `${block.type ?? "block"} (unsupported block type)`;
}

function formatAirport(endpoint: FlightBlock["depart"]): string {
  const iata = endpoint?.airport?.iata;
  const name = endpoint?.airport?.cityName ?? endpoint?.airport?.name ?? "?";
  return iata ? `${name} (${iata})` : name;
}

function formatTime(iso: string): string {
  const match = /(\d{2}:\d{2})/.exec(iso);
  return match ? match[1]! : iso;
}

/** Extract plain text from a Quill Delta `{ops: [{insert: "..."}]}`. */
function quillToPlain(delta: QuillDelta | undefined): string {
  if (!delta?.ops) return "";
  return delta.ops
    .map((op) => (typeof op.insert === "string" ? op.insert : ""))
    .join("");
}

function formatDayLabel(section: Section): string {
  if (!section.date) return "Day";
  const date = new Date(`${section.date}T00:00:00Z`);
  const weekday = date.toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
  const monthDay = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return section.heading?.trim()
    ? `${weekday} ${monthDay} — ${section.heading.trim()}`
    : `${weekday} ${monthDay}`;
}
