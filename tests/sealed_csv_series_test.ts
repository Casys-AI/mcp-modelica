import { assertEquals, assertThrows } from "@std/assert";
import { ValidationError } from "../src/domain/errors.ts";
import { summarizeSealedNumericCsv } from "../src/domain/sealed-csv-series.ts";

Deno.test("sealed CSV summaries retain the final row when the sample budget is one", () => {
  const summary = summarizeSealedNumericCsv(
    ["time,temperature", "0,20", "1,42", "2,94"].join("\n"),
    1,
  );
  assertEquals(summary.row_count, 3);
  assertEquals(summary.columns, [
    { name: "time", minimum: 0, maximum: 2, final: 2 },
    { name: "temperature", minimum: 20, maximum: 94, final: 94 },
  ]);
  assertEquals(summary.samples, [{ row_index: 2, values: { time: 2, temperature: 94 } }]);
});

Deno.test("sealed CSV summaries reject malformed or non-numeric evidence", () => {
  for (
    const source of [
      "time,time\n0,1",
      "time,temperature\n0,not-a-number",
      'time,temperature\n0,"unterminated',
      'time,temperature\n0,"1"2',
    ]
  ) {
    assertThrows(
      () => summarizeSealedNumericCsv(source, 4),
      ValidationError,
    );
  }
});
