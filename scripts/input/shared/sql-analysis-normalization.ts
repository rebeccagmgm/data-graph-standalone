/**
 * Preserve SQL occurrences in the analysis view.
 *
 * The Input Pack keeps the platform response byte-for-byte.
 * SQL text alone cannot distinguish repeated execution from duplicated transport
 * responses. The current slot contract supplies no response-boundary evidence,
 * so even byte-identical blocks must survive. Keep bytes unchanged as well so
 * statement offsets remain attributable to the original source. Retain this
 * entry point for existing consumers; it is not a SQL equivalence test.
 */
export function normalizeRepeatedSqlForAnalysis(content: string): string {
	return content;
}
