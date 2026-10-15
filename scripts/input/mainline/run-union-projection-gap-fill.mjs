import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkspacePaths } from "../../config/workspace-paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const paths = resolveWorkspacePaths({ cwd: repoRoot });
const unionDir = join(repoRoot, "tmp/dm-otc-n-titans-union-20260907");
const exportFile = join(unionDir, "ids-needs-projection.txt");
const logPath = join(unionDir, "projection-gap-fill.log");

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line, "utf8");
}

if (!existsSync(exportFile)) {
  throw new Error(`EXPORT_FILE_MISSING: ${exportFile}`);
}

const taskIds = readFileSync(exportFile, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

log(`start tasks=${taskIds.length} (single project-task-local invocation)`);
log(
  `npm run project-task-local -- --data-root ... --task-ids-file ${exportFile}`,
);
execFileSync(
  "npm",
  [
    "run",
    "project-task-local",
    "--",
    "--data-root",
    paths.dataRoot,
    "--facts-root",
    paths.factsRoot,
    "--schedule-cache-root",
    paths.evidenceRoot,
    "--projection-root",
    paths.projectionRoot,
    "--task-ids-file",
    exportFile,
  ],
  { cwd: repoRoot, stdio: "inherit", shell: true },
);
log(`done tasks=${taskIds.length}`);
