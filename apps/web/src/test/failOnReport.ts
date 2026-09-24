// Unexpected-report hook for fixtures: rethrow so the test fails with the original error.
export function failOnReport(error: unknown): never {
  throw error;
}
