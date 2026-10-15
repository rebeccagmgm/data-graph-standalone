import { resolve } from "node:path";

import {
	backfillWriterCatalogFromFacts,
	defaultWriterCatalogPath,
} from "./writer-catalog.ts";

function option(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function main(): void {
	const args = process.argv.slice(2);
	const dataRoot = option(args, "--data-root");
	const factsRoot = option(args, "--facts-root");
	if (!dataRoot || !factsRoot) {
		throw new Error(
			"usage: backfill-writer-catalog --data-root <pack> --facts-root <facts> [--catalog <sqlite>]",
		);
	}
	const catalogPath = option(args, "--catalog")
		? resolve(option(args, "--catalog")!)
		: defaultWriterCatalogPath(dataRoot);
	const result = backfillWriterCatalogFromFacts({
		dataRoot: resolve(dataRoot),
		factsRoot: resolve(factsRoot),
		catalogPath,
	});
	process.stdout.write(`${JSON.stringify({ catalogPath, ...result }, null, 2)}\n`);
}

main();
