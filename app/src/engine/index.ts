// Public API of the analysis engine. Pure functions, no DOM access, so the
// same code runs in the browser, in Vitest and in the eval harness.
//
//   const table = readTable(bytesOrText, fileName);   // CSV / TSV / XLSX / XLS
//   const detection = detect(table);                  // guess format + columns
//   const parsed = parse(table, detection);           // fills -> round trips, validation
//   const review = analyze(parsed);                   // summary + ranked habits
//
// analyzeFile() chains all four for callers that don't need the mapping step.

export * from './types';
export { readTable } from './read';
export { detect, FIELD_LABELS, FORMAT_FIELDS } from './detect';
export { parse } from './parse';
export { analyze } from './analyze';
export { checkCommitment } from './commitment';
export { formatInr, formatSignedInr, formatDate, formatDateTime } from './format';

import { readTable } from './read';
import { detect } from './detect';
import { parse } from './parse';
import { analyze } from './analyze';
import type { Detection, ParseResult, RawTable, Review } from './types';

export function analyzeFile(
  data: ArrayBuffer | Uint8Array | string,
  fileName: string,
): { table: RawTable; detection: Detection; parsed: ParseResult; review: Review } {
  const table = readTable(data, fileName);
  const detection = detect(table);
  if (!detection.format) throw new Error(detection.problems[0] ?? 'Could not recognise this file.');
  const parsed = parse(table, detection);
  return { table, detection, parsed, review: analyze(parsed) };
}
