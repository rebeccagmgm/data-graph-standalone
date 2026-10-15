import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultOutDir =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data/tmp/hivetask-empty-script-miss";
const dataRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data";

function main(): void {
  const outDir = defaultOutDir;
  const exportScript = join(
    repoRoot,
    "scripts/survey/export-input-pack-retry-task-ids.mjs",
  );
  execFileSync("node", [exportScript], { stdio: "inherit", cwd: repoRoot });
  const idsPath = join(outDir, "input-pack-retry-task-ids.txt");
  if (!existsSync(idsPath)) throw new Error("RETRY_IDS_MISSING");
  const count = readFileSync(idsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean).length;
  process.stderr.write(`[input-pack-retry] batch retry tasks=${count}\n`);
  execFileSync(
    "npm",
    [
      "run",
      "input-pack:from-cache",
      "--",
      "--data-root",
      dataRoot,
      "--task-ids-file",
      idsPath,
      "--force",
    ],
    { stdio: "inherit", cwd: repoRoot, shell: true },
  );
}

main();
