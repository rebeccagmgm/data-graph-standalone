type JsonRecord = Record<string, any>;

export type ParserSqlInput = {
	sql: string;
	restore: <T>(value: T) => T;
};

function parserToken(length: number, index: number): string {
	if (length < 3) throw new Error(`parser placeholder is too short to sanitize safely: ${length}`);
	const payloadLength = length - 2;
	const payload = index.toString(36).toUpperCase().padStart(payloadLength, "0").slice(-payloadLength);
	return `_P${payload}`;
}

export function sanitizeSqlForParser(sql: string): ParserSqlInput {
	const rawToToken = new Map<string, string>();
	const tokenToRaw = new Map<string, string>();
	let tokenIndex = 0;
	const register = (raw: string): string => {
		const existing = rawToToken.get(raw);
		if (existing) return existing;
		let token = parserToken(raw.length, tokenIndex++);
		while (sql.includes(token) || tokenToRaw.has(token)) token = parserToken(raw.length, tokenIndex++);
		rawToToken.set(raw, token);
		tokenToRaw.set(token, raw);
		return token;
	};

	// Scheduler placeholders are lexical values, even when they occur inside
	// a table identifier. Keep replacement length identical so every parser
	// span remains a valid span in the original SQL.
	let sanitized = sql.replace(/\$\{[^{}\r\n]*\}/g, (raw) => register(raw));

	// Some source systems also expose legacy bare identifiers containing '$'.
	// Sanitize those only outside quoted strings/comments; quoted identifiers
	// already have an unambiguous SQL representation.
	let output = "";
	let quote: "'" | '"' | "`" | null = null;
	let lineComment = false;
	let blockComment = false;
	const isIdentifierStart = (char: string): boolean => /[A-Za-z_]/.test(char);
	const isIdentifierPart = (char: string): boolean => /[A-Za-z0-9_$]/.test(char);
	for (let index = 0; index < sanitized.length;) {
		const char = sanitized[index]!;
		const next = sanitized[index + 1] ?? "";
		if (lineComment) {
			output += char;
			index++;
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			output += char;
			index++;
			if (char === "*" && next === "/") {
				output += next;
				index++;
				blockComment = false;
			}
			continue;
		}
		if (quote) {
			output += char;
			index++;
			if (char === quote) {
				if (next === quote) {
					output += next;
					index++;
				} else {
					quote = null;
				}
			}
			continue;
		}
		if (char === "-" && next === "-") {
			output += "--";
			index += 2;
			lineComment = true;
			continue;
		}
		if (char === "/" && next === "*") {
			output += "/*";
			index += 2;
			blockComment = true;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			output += char;
			index++;
			quote = char;
			continue;
		}
		if (isIdentifierStart(char)) {
			let end = index + 1;
			while (end < sanitized.length && isIdentifierPart(sanitized[end]!)) end++;
			const identifier = sanitized.slice(index, end);
			output += identifier.includes("$") ? register(identifier) : identifier;
			index = end;
			continue;
		}
		output += char;
		index++;
	}
	sanitized = output;

	const replacements = [...tokenToRaw.entries()].sort(([left], [right]) => right.length - left.length);
	const restoreString = (value: string): string => replacements.reduce((current, [token, raw]) => {
		const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return current.replace(new RegExp(escaped, "gi"), () => raw);
	}, value);
	const restore = <T>(value: T): T => {
		const visit = (item: unknown): unknown => {
			if (typeof item === "string") return restoreString(item);
			if (Array.isArray(item)) return item.map(visit);
			if (item && typeof item === "object") {
				for (const [key, child] of Object.entries(item as JsonRecord)) (item as JsonRecord)[key] = visit(child);
			}
			return item;
		};
		return visit(value) as T;
	};
	return { sql: sanitized, restore };
}

export function maskWithInsertTargetForParser(sql: string): string {
	const masked = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\r\n]*|\/\*[\s\S]*?\*\//g, (value) =>
		" ".repeat(value.length),
	);
	const ranges: Array<{ start: number; end: number }> = [];
	let statementStart = 0;
	for (let statementEnd = 0; statementEnd <= masked.length; statementEnd += 1) {
		if (statementEnd < masked.length && masked[statementEnd] !== ";") continue;
		const statement = masked.slice(statementStart, statementEnd);
		if (/^\s*WITH\b/i.test(statement)) {
			const write = statement.match(
				/\b(?:INSERT\s+(?:OVERWRITE|INTO)\s+(?:TABLE\s+)?|MERGE\s+INTO\s+)([A-Za-z0-9_`".\-]+)/i,
			);
			if (write?.index !== undefined) {
				const start = statementStart + write.index;
				let end = start + write[0].length;
				const partition = masked.slice(end, statementEnd).match(/^\s*PARTITION\s*\(/i);
				if (partition) {
					const opening = end + partition[0].lastIndexOf("(");
					let depth = 0;
					for (let index = opening; index < statementEnd; index += 1) {
						if (masked[index] === "(") depth += 1;
						else if (masked[index] === ")") {
							depth -= 1;
							if (depth === 0) {
								end = index + 1;
								break;
							}
						}
					}
				}
				ranges.push({ start, end });
			}
		}
		statementStart = statementEnd + 1;
	}
	return ranges.reduceRight(
		(current, range) =>
			`${current.slice(0, range.start)}${" ".repeat(range.end - range.start)}${current.slice(range.end)}`,
		sql,
	);
}
