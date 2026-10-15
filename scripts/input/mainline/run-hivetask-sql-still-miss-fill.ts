import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultOutDir =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data/tmp/hivetask-empty-script-miss";

function main(): void {
  const outDir = defaultOutDir;
  const exportScript = join(
    repoRoot,
    "scripts/survey/export-hivetask-sql-still-miss.mjs",
  );
  execFileSync("node", [exportScript], { stdio: "inherit", cwd: repoRoot });
  const idsPath = join(outDir, "hive-sql-still-miss-task-ids.txt");
  if (!existsSync(idsPath)) throw new Error("STILL_MISS_IDS_MISSING");
  const count = readFileSync(idsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean).length;
  if (count === 0) {
    process.stderr.write("[hive-sql-still-miss-fill] nothing to fill\n");
    return;
  }
  process.stderr.write(`[hive-sql-still-miss-fill] tasks=${count}\n`);
  execFileSync(
    "npm",
    [
      "run",
      "input-pack:fill-hive-task-sql-cache",
      "--",
      "--task-ids-file",
      idsPath,
      "--force",
      "--max-errors",
      String(Math.max(count, 1)),
    ],
    { stdio: "inherit", cwd: repoRoot, shell: true },
  );
}

main();
