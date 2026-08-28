import { ValidationError } from "./errors.ts";

/** A result CSV is already capped by the durable evidence contract. */
export const MAX_SEALED_CSV_SERIES_SAMPLES = 128;
export const DEFAULT_SEALED_CSV_SERIES_SAMPLES = 64;
const MAX_SEALED_CSV_SERIES_COLUMNS = 128;

export interface SealedCsvSeriesColumn {
  name: string;
  minimum: number;
  maximum: number;
  final: number;
}

export interface SealedCsvSeriesSample {
  /** Zero-based index within the CSV data rows; the header is not a row. */
  row_index: number;
  values: Record<string, number>;
}

export interface SealedCsvSeriesSummary {
  row_count: number;
  columns: SealedCsvSeriesColumn[];
  sampling: {
    strategy: "evenly-spaced-including-endpoints";
    requested_max_samples: number;
    returned_samples: number;
  };
  samples: SealedCsvSeriesSample[];
}

/**
 * Summarize one already-sealed numeric CSV without returning its full series.
 * This parser is intentionally strict: the bounded reader is evidence-aware,
 * not a permissive general-purpose CSV import endpoint.
 */
export function summarizeSealedNumericCsv(
  source: string,
  maxSamples: number,
): SealedCsvSeriesSummary {
  if (
    !Number.isSafeInteger(maxSamples) || maxSamples < 1 ||
    maxSamples > MAX_SEALED_CSV_SERIES_SAMPLES
  ) {
    throw new ValidationError(
      `max_samples must be an integer between 1 and ${MAX_SEALED_CSV_SERIES_SAMPLES}.`,
    );
  }

  const lines = source.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  if (lines.length < 2) {
    throw new ValidationError("Sealed result.csv must contain a header and at least one data row.");
  }

  const headers = parseCsvRow(lines[0], 1).map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim()
  );
  if (headers.length === 0 || headers.length > MAX_SEALED_CSV_SERIES_COLUMNS) {
    throw new ValidationError(
      `Sealed result.csv must expose between 1 and ${MAX_SEALED_CSV_SERIES_COLUMNS} columns for a bounded summary.`,
    );
  }
  if (headers.some((header) => header.length === 0)) {
    throw new ValidationError("Sealed result.csv contains an empty column name.");
  }
  if (new Set(headers).size !== headers.length) {
    throw new ValidationError("Sealed result.csv contains duplicate column names.");
  }

  const statistics = headers.map(() => ({
    minimum: Number.POSITIVE_INFINITY,
    maximum: Number.NEGATIVE_INFINITY,
    final: 0,
  }));
  let rowCount = 0;
  for (const [lineIndex, line] of lines.slice(1).entries()) {
    const values = parseNumericDataRow(line, headers.length, lineIndex + 2);
    for (const [columnIndex, value] of values.entries()) {
      statistics[columnIndex].minimum = Math.min(statistics[columnIndex].minimum, value);
      statistics[columnIndex].maximum = Math.max(statistics[columnIndex].maximum, value);
      statistics[columnIndex].final = value;
    }
    rowCount++;
  }
  if (rowCount === 0) {
    throw new ValidationError("Sealed result.csv has no numeric data rows.");
  }

  const selected = new Set(sampleRowIndexes(rowCount, maxSamples));
  const samples: SealedCsvSeriesSample[] = [];
  for (const [rowIndex, line] of lines.slice(1).entries()) {
    if (!selected.has(rowIndex)) continue;
    const values = parseNumericDataRow(line, headers.length, rowIndex + 2);
    samples.push({
      row_index: rowIndex,
      values: Object.fromEntries(headers.map((header, index) => [header, values[index]])),
    });
  }

  return {
    row_count: rowCount,
    columns: headers.map((name, index) => ({ name, ...statistics[index] })),
    sampling: {
      strategy: "evenly-spaced-including-endpoints",
      requested_max_samples: maxSamples,
      returned_samples: samples.length,
    },
    samples,
  };
}

function parseNumericDataRow(line: string, width: number, lineNumber: number): number[] {
  if (line.length === 0) {
    throw new ValidationError(`Sealed result.csv has an empty data row at line ${lineNumber}.`);
  }
  const cells = parseCsvRow(line, lineNumber);
  if (cells.length !== width) {
    throw new ValidationError(
      `Sealed result.csv row ${lineNumber} has ${cells.length} fields; expected ${width}.`,
    );
  }
  return cells.map((cell, index) => {
    if (cell.trim().length === 0) {
      throw new ValidationError(
        `Sealed result.csv row ${lineNumber} column ${index + 1} is not a finite number.`,
      );
    }
    const value = Number(cell);
    if (!Number.isFinite(value)) {
      throw new ValidationError(
        `Sealed result.csv row ${lineNumber} column ${index + 1} is not a finite number.`,
      );
    }
    return value;
  });
}

function parseCsvRow(line: string, lineNumber: number): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index++;
      } else if (quoted) {
        quoted = false;
        quoteClosed = true;
      } else if (current.length === 0 && !quoteClosed) {
        quoted = true;
      } else {
        throw new ValidationError(`Sealed result.csv has an invalid quote at line ${lineNumber}.`);
      }
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
      quoteClosed = false;
    } else if (quoteClosed) {
      throw new ValidationError(
        `Sealed result.csv has characters after a closing quote at line ${lineNumber}.`,
      );
    } else {
      current += character;
    }
  }
  if (quoted) {
    throw new ValidationError(
      `Sealed result.csv has an unterminated quoted field at line ${lineNumber}.`,
    );
  }
  values.push(current);
  return values;
}

function sampleRowIndexes(rowCount: number, maxSamples: number): number[] {
  const count = Math.min(rowCount, maxSamples);
  if (count === 1) return [rowCount - 1];
  return Array.from(
    { length: count },
    (_unused, index) => Math.round(index * (rowCount - 1) / (count - 1)),
  );
}
