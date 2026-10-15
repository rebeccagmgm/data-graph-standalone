import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	Schema,
	tokenize,
  type SchemaMapping,
  type SchemaProvider,
} from "sqllens";
import { sha256File, validateTableDocument, type TableDocument } from "../input/shared/input-pack.ts";

export type DdlColumn = {
	readonly name: string;
	readonly type?: string;
};

export type DdlSchemaIssue = {
	readonly code:
		| "MISSING_TABLE"
		| "INVALID_TABLE_DOCUMENT"
		| "MISSING_DDL"
		| "DDL_PATH_UNSAFE"
		| "DDL_HASH_MISMATCH"
		| "DDL_PARSE_FAILED"
		| "DDL_PARSE_WARNING"
		| "DUPLICATE_TABLE";
	readonly qualified_name?: string;
	readonly path?: string;
	readonly message: string;
};

export type ParsedDdlSchema = {
	readonly columns: readonly DdlColumn[];
	readonly partition_columns: readonly string[];
	readonly warnings: readonly string[];
};

export type LoadedDdlSchema = {
	readonly schema: SchemaProvider;
	readonly loaded: readonly {
		readonly qualified_name: string;
		readonly columns: readonly string[];
		readonly path: string;
	}[];
	readonly missing: readonly string[];
	readonly issues: readonly DdlSchemaIssue[];
};

type Identifier = { readonly name: string; readonly quoted: boolean; readonly end: number };

function isIdentifierQuote(value: string): boolean {
	return value === "`" || value === '"' || value === "[";
}

function matchingQuote(value: string): string {
	return value === "[" ? "]" : value;
}

function readIdentifier(text: string, start: number): Identifier | undefined {
	let index = start;
	while (/\s/.test(text[index] ?? "")) index += 1;
	const first = text[index];
	if (!first) return undefined;
	if (isIdentifierQuote(first)) {
		const close = matchingQuote(first);
		let value = "";
		for (index += 1; index < text.length; index += 1) {
			const current = text[index]!;
			if (current === close) {
				if (text[index + 1] === close) {
					value += close;
					index += 1;
					continue;
				}
				return { name: value, quoted: true, end: index + 1 };
			}
			value += current;
		}
		return undefined;
	}
	const match = /^[A-Za-z_][A-Za-z0-9_$#-]*/.exec(text.slice(index));
	if (!match) return undefined;
	return { name: match[0]!, quoted: false, end: index + match[0]!.length };
}

function skipQuoted(text: string, start: number, quote: string): number {
	for (let index = start + 1; index < text.length; index += 1) {
		if (text[index] !== quote) continue;
		if (text[index + 1] === quote) {
			index += 1;
			continue;
		}
		return index + 1;
	}
	return text.length;
}

/** Lexical CREATE header only; SELECT semantics remain owned by the plan adapter. */
export function readCreateTableHeader(sql: string): {
	readonly target: string;
	readonly columnListStart: number | null;
	readonly asQuery: boolean;
} | null {
	const tokens = tokenize(sql, "databricks").filter(token => token.role !== "comment" && token.role !== "whitespace");
	let index = 0;
	// Metadata DDL may contain a preceding DROP. Only consider statement starts,
	// never CREATE text inside a comment, string, or SELECT expression.
	while (tokens[index] && tokens[index]!.text.toUpperCase() !== "CREATE") {
		while (tokens[index] && tokens[index]!.text !== ";") index += 1;
		index += 1;
	}
	const take = (word: string): boolean => {
		if (tokens[index]?.text.toUpperCase() !== word) return false;
		index += 1;
		return true;
	};
	if (!take("CREATE")) return null;
	if (take("OR") && !take("REPLACE")) return null;
	while (["EXTERNAL", "TEMPORARY", "TEMP"].includes(tokens[index]?.text.toUpperCase() ?? "")) index += 1;
	if (!take("TABLE")) return null;
	if (take("IF") && (!take("NOT") || !take("EXISTS"))) return null;
	const parts: string[] = [];
	do {
		const token = tokens[index];
		if (!token) return null;
		const identifier = readIdentifier(sql, token.start);
		if (!identifier) return null;
		parts.push(identifier.name);
		while (tokens[index] && tokens[index]!.start < identifier.end) index += 1;
	} while (take("."));
	const columnListStart = tokens[index]?.text === "(" ? tokens[index]!.start : null;
	let depth = 0;
	let asQuery = false;
	for (; index < tokens.length; index += 1) {
		const value = tokens[index]!.text.toUpperCase();
		if (value === ";") break;
		if (value === "(") depth += 1;
		else if (value === ")") depth -= 1;
		else if (depth === 0 && value === "AS" && ["SELECT", "WITH"].includes(tokens[index + 1]?.text.toUpperCase() ?? "")) {
			asQuery = true;
			break;
		}
	}
	return { target: parts.join("."), columnListStart, asQuery };
}

function matchingParenthesis(text: string, open: number): number {
	let depth = 0;
	for (let index = open; index < text.length; index += 1) {
		const current = text[index]!;
		if (current === "'" || current === '"' || current === "`") {
			index = skipQuoted(text, index, current) - 1;
			continue;
		}
		if (current === "-" && text[index + 1] === "-") {
			const newline = text.indexOf("\n", index + 2);
			index = newline < 0 ? text.length : newline;
			continue;
		}
		if (current === "/" && text[index + 1] === "*") {
			const close = text.indexOf("*/", index + 2);
			index = close < 0 ? text.length : close + 1;
			continue;
		}
		if (current === "(") depth += 1;
		if (current === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let parentheses = 0;
	let angles = 0;
	for (let index = 0; index < text.length; index += 1) {
		const current = text[index]!;
		if (current === "'" || current === '"' || current === "`") {
			index = skipQuoted(text, index, current) - 1;
			continue;
		}
		if (current === "-" && text[index + 1] === "-") {
			const newline = text.indexOf("\n", index + 2);
			index = newline < 0 ? text.length : newline;
			continue;
		}
		if (current === "/" && text[index + 1] === "*") {
			const close = text.indexOf("*/", index + 2);
			index = close < 0 ? text.length : close + 1;
			continue;
		}
		if (current === "(") parentheses += 1;
		else if (current === ")") parentheses -= 1;
		else if (current === "<") angles += 1;
		else if (current === ">" && angles > 0) angles -= 1;
		else if (current === "," && parentheses === 0 && angles === 0) {
			parts.push(text.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

function ignoredTableDefinition(name: Identifier): boolean {
	if (name.quoted) return false;
	return new Set([
		"CONSTRAINT",
		"PRIMARY",
		"UNIQUE",
		"KEY",
		"INDEX",
		"CHECK",
		"FOREIGN",
		"PARTITION",
		"CLUSTERED",
		"DISTRIBUTED",
	]).has(name.name.toUpperCase());
}

function stripLeadingComments(text: string): string {
	let index = 0;
	while (index < text.length) {
		while (/\s/.test(text[index] ?? "")) index += 1;
		if (text[index] === "-" && text[index + 1] === "-") {
			const newline = text.indexOf("\n", index + 2);
			index = newline < 0 ? text.length : newline + 1;
			continue;
		}
		if (text[index] === "/" && text[index + 1] === "*") {
			const close = text.indexOf("*/", index + 2);
			index = close < 0 ? text.length : close + 2;
			continue;
		}
		break;
	}
	return text.slice(index);
}

function parseDefinitions(body: string): DdlColumn[] {
	const columns: DdlColumn[] = [];
	for (const definition of splitTopLevel(body)) {
		const trimmed = stripLeadingComments(definition).trim();
		if (!trimmed) continue;
		const identifier = readIdentifier(trimmed, 0);
		if (!identifier || ignoredTableDefinition(identifier)) continue;
		const typeText = trimmed.slice(identifier.end).trim();
		columns.push({ name: identifier.name, ...(typeText ? { type: typeText } : {}) });
	}
	return columns;
}

function columnNames(columns: readonly DdlColumn[]): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const column of columns) {
		const key = column.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		names.push(column.name);
	}
	return names;
}

function uniqueColumns(columns: readonly DdlColumn[]): DdlColumn[] {
	const seen = new Set<string>();
	return columns.filter((column) => {
		const key = column.name.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function topLevelKeywordIndex(text: string, keyword: string, start = 0): number {
	let parentheses = 0;
	const lower = text.toLowerCase();
	const target = keyword.toLowerCase();
	for (let index = start; index <= text.length - target.length; index += 1) {
		const current = text[index]!;
		if (current === "'" || current === '"' || current === "`") {
			index = skipQuoted(text, index, current) - 1;
			continue;
		}
		if (current === "-" && text[index + 1] === "-") {
			const newline = text.indexOf("\n", index + 2);
			index = newline < 0 ? text.length : newline;
			continue;
		}
		if (current === "/" && text[index + 1] === "*") {
			const close = text.indexOf("*/", index + 2);
			index = close < 0 ? text.length : close + 1;
			continue;
		}
		if (current === "(") {
			parentheses += 1;
			continue;
		}
		if (current === ")") {
			parentheses = Math.max(0, parentheses - 1);
			continue;
		}
		if (parentheses !== 0 || !lower.startsWith(target, index)) continue;
		const before = text[index - 1];
		const after = text[index + target.length];
		if (!before || !/[A-Za-z0-9_$]/.test(before)) {
			if (!after || !/[A-Za-z0-9_$]/.test(after)) return index;
		}
	}
	return -1;
}

function topLevelWords(text: string): string[] {
	const words: string[] = [];
	let parentheses = 0;
	for (let index = 0; index < text.length; index += 1) {
		const current = text[index]!;
		if (current === "'") {
			index = skipQuoted(text, index, current) - 1;
			continue;
		}
		if (current === '"' || current === "`") {
			const identifier = readIdentifier(text, index);
			if (!identifier) {
				index = skipQuoted(text, index, current) - 1;
				continue;
			}
			words.push(identifier.name);
			index = identifier.end - 1;
			continue;
		}
		if (current === "-" && text[index + 1] === "-") {
			const newline = text.indexOf("\n", index + 2);
			index = newline < 0 ? text.length : newline;
			continue;
		}
		if (current === "/" && text[index + 1] === "*") {
			const close = text.indexOf("*/", index + 2);
			index = close < 0 ? text.length : close + 1;
			continue;
		}
		if (current === "(") {
			parentheses += 1;
			continue;
		}
		if (current === ")") {
			parentheses = Math.max(0, parentheses - 1);
			continue;
		}
		if (parentheses !== 0 || !/[A-Za-z_]/.test(current)) continue;
		const match = /^[A-Za-z_][A-Za-z0-9_$#]*/.exec(text.slice(index));
		if (!match) continue;
		words.push(match[0]!);
		index += match[0]!.length - 1;
	}
	return words;
}

function parseSelectOutputColumns(sql: string): DdlColumn[] {
	const select = topLevelKeywordIndex(sql, "select");
	if (select < 0) return [];
	const from = topLevelKeywordIndex(sql, "from", select + "select".length);
	if (from < 0) return [];
	const columns: DdlColumn[] = [];
	for (const definition of splitTopLevel(sql.slice(select + "select".length, from))) {
		const words = topLevelWords(definition);
		if (words.length === 0) continue;
		const alias = words[words.length - 1]!;
		columns.push({ name: alias });
	}
	return columns;
}

export function parseDdlSchema(ddl: string): ParsedDdlSchema {
	const create = readCreateTableHeader(ddl);
	if (!create) {
		// SZData can return a view's defining SELECT through the table-ddl
		// endpoint. Its output columns are still valid schema evidence for
		// consumers of that view, even though there is no CREATE TABLE list.
		const viewColumns = parseSelectOutputColumns(ddl);
		if (viewColumns.length > 0)
			return { columns: viewColumns, partition_columns: [], warnings: [] };
		return { columns: [], partition_columns: [], warnings: ["CREATE TABLE not found"] };
	}
	const open = create.columnListStart;
	if (open === null) return { columns: [], partition_columns: [], warnings: ["table column list not found"] };
	const close = matchingParenthesis(ddl, open);
	if (close < 0) return { columns: [], partition_columns: [], warnings: ["table column list is unbalanced"] };

	const columns = parseDefinitions(ddl.slice(open + 1, close));
	const partitionMatch = /\bpartitioned\s+by\s*\(/i.exec(ddl.slice(close + 1));
	const partitionColumns: DdlColumn[] = [];
	if (partitionMatch) {
		const partitionOpen = close + 1 + partitionMatch.index + partitionMatch[0].lastIndexOf("(");
		const partitionClose = matchingParenthesis(ddl, partitionOpen);
		if (partitionClose >= 0) partitionColumns.push(...parseDefinitions(ddl.slice(partitionOpen + 1, partitionClose)));
	}

	const allColumns = [...columns, ...partitionColumns];
	const foldedColumns = uniqueColumns(allColumns);
	const warnings: string[] = [];
	if (allColumns.length === 0) warnings.push("no column definitions found");
	if (foldedColumns.length !== allColumns.length) warnings.push("duplicate column names were folded");
	return {
		columns: foldedColumns,
		partition_columns: columnNames(partitionColumns),
		warnings,
	};
}

function stripIdent(value: string): string {
	return value.replace(/[`"]/g, "").replace(/\s+/g, "");
}

/** Source table of `CREATE TABLE … LIKE source`. Column-less LIKE is not schema. */
export function createTableLikeSource(ddl: string): string | undefined {
	const match =
		/\bcreate\s+(?:or\s+replace\s+)?(?:external\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*))?\s+like\s+((?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*))?)/i.exec(
			ddl,
		);
	const source = match?.[1]?.trim();
	return source ? stripIdent(source) : undefined;
}

function tableJsonFiles(root: string): string[] {
	const output: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name === "table.json") output.push(path);
		}
	};
	visit(resolve(root));
	return output.sort();
}

function addMapping(mapping: SchemaMapping, qualifiedName: string, columns: readonly string[]): void {
	const parts = qualifiedName.split(".").filter(Boolean);
	if (parts.length === 0 || columns.length === 0) return;
	let namespace = mapping;
	for (const part of parts.slice(0, -1)) {
		const existing = namespace[part];
		if (typeof existing !== "object" || existing === null || "nullable" in existing) namespace[part] = {};
		namespace = namespace[part] as SchemaMapping;
	}
	namespace[parts[parts.length - 1]!] = Object.fromEntries(columns.map((column) => [column, "unknown"]));
}

function openWorldSchema(catalog: Schema): SchemaProvider {
	return {
		world: "open",
		version: catalog.version,
		columnsFor: catalog.columnsFor.bind(catalog),
		tableCandidates: catalog.tableCandidates.bind(catalog),
		childrenOf: catalog.childrenOf.bind(catalog),
		tables: catalog.tables.bind(catalog),
	};
}

function isContained(root: string, candidate: string): boolean {
	const rootPath = resolve(root);
	const candidatePath = resolve(candidate);
	const rel = relative(rootPath, candidatePath);
	return rel === "" || (!rel.startsWith("..") && !rel.includes(":") && !rel.startsWith("/"));
}

function sameSuffix(path: string, suffix: string): boolean {
	const pathParts = path.toLowerCase().split(".").filter(Boolean);
	const suffixParts = suffix.toLowerCase().split(".").filter(Boolean);
	if (suffixParts.length === 0 || suffixParts.length > pathParts.length) return false;
	const offset = pathParts.length - suffixParts.length;
	return suffixParts.every((part, index) => pathParts[offset + index] === part);
}

function isTestSchemaCandidate(qualifiedName: string): boolean {
  const schemaParts = qualifiedName.split(".").slice(0, -1);
  return schemaParts.some(
    (part) =>
      part.toLowerCase() === "gfstest" ||
      /(?:^|[._-])(?:test|uat)(?:[._-]|$)/i.test(part),
  );
}

export function loadSchemaFromTablesRoot(tablesRoot: string, requiredTables: readonly string[] = []): LoadedDdlSchema {
	const wanted = new Map(requiredTables.map((name) => [name.toLowerCase(), name]));
	const documents = new Map<string, { readonly document: TableDocument; readonly path: string }>();
	const issues: DdlSchemaIssue[] = [];

	for (const tableJsonPath of tableJsonFiles(tablesRoot)) {
		try {
			const raw: unknown = JSON.parse(readFileSync(tableJsonPath, "utf8"));
			validateTableDocument(raw);
			const document = raw as TableDocument;
			const key = document.qualifiedName.toLowerCase();
			if (documents.has(key)) {
				issues.push({ code: "DUPLICATE_TABLE", qualified_name: document.qualifiedName, path: tableJsonPath, message: "duplicate qualifiedName across table evidence" });
				continue;
			}
			documents.set(key, { document, path: tableJsonPath });
		} catch (error) {
			issues.push({ code: "INVALID_TABLE_DOCUMENT", path: tableJsonPath, message: error instanceof Error ? error.message : String(error) });
		}
	}

	const names = requiredTables.length > 0 ? requiredTables : [...documents.values()].map(({ document }) => document.qualifiedName);
	const mapping: SchemaMapping = {};
	const loaded: Array<LoadedDdlSchema["loaded"][number]> = [];
	const missing: string[] = [];

	for (const requestedName of names) {
		const exactEntry = documents.get(requestedName.toLowerCase());
		const suffixEntries = exactEntry
			? []
			: [...documents.values()].filter(({ document }) => sameSuffix(document.qualifiedName, requestedName));
		const nonTestSuffixEntries = suffixEntries.filter(
			({ document }) => !isTestSchemaCandidate(document.qualifiedName),
		);
		const entry = exactEntry ??
			(nonTestSuffixEntries.length === 1
				? nonTestSuffixEntries[0]
				: suffixEntries.length === 1
					? suffixEntries[0]
					: undefined);
		if (!entry) {
			missing.push(requestedName);
			issues.push({
				code: "MISSING_TABLE",
				qualified_name: requestedName,
				message:
					suffixEntries.length > 1
						? `ambiguous table.json suffix match (${suffixEntries.length} candidates)`
						: "no matching table.json",
			});
			continue;
		}
		const { document, path: tableJsonPath } = entry;
		const tableDirectory = dirname(tableJsonPath);
		const ddlFile = document.ddlFile as { readonly path: string; readonly sha256: string };
		const ddlPath = resolve(tableDirectory, ddlFile.path);
		if (!isContained(tableDirectory, ddlPath)) {
			issues.push({ code: "DDL_PATH_UNSAFE", qualified_name: document.qualifiedName, path: ddlPath, message: "ddlFile path escapes table evidence directory" });
			continue;
		}
		if (!existsSync(ddlPath)) {
			issues.push({ code: "MISSING_DDL", qualified_name: document.qualifiedName, path: ddlPath, message: "ddl.sql is missing" });
			continue;
		}
		const actualHash = sha256File(ddlPath);
		if (actualHash !== ddlFile.sha256) {
			issues.push({ code: "DDL_HASH_MISMATCH", qualified_name: document.qualifiedName, path: ddlPath, message: `expected ${ddlFile.sha256}, got ${actualHash}` });
			continue;
		}
		const parsed = parseDdlSchema(readFileSync(ddlPath, "utf8"));
		for (const warning of parsed.warnings)
			issues.push({ code: warning === "no column definitions found" ? "DDL_PARSE_FAILED" : "DDL_PARSE_WARNING", qualified_name: document.qualifiedName, path: ddlPath, message: warning });
		const namesFromDdl = columnNames(parsed.columns);
		if (namesFromDdl.length === 0) continue;
		addMapping(mapping, document.qualifiedName, namesFromDdl);
		loaded.push({ qualified_name: document.qualifiedName, columns: namesFromDdl, path: tableJsonPath });
	}

	const catalog = new Schema(mapping);
	return {
		schema: missing.length > 0 || issues.length > 0 ? openWorldSchema(catalog) : catalog,
		loaded,
		missing,
		issues,
	};
}
