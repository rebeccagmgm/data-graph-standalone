import { loadTaskKnowledge, verifyTaskKnowledge } from "./task-knowledge.mjs";

const usage =
  "node scripts/knowledge/query.mjs --task-id <id> [--verify-evidence]";
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
  } else {
    if (
      args[0] !== "--task-id" ||
      !args[1] ||
      ![2, 3].includes(args.length) ||
      (args.length === 3 && args[2] !== "--verify-evidence")
    )
      throw new Error(usage);
    let record = await loadTaskKnowledge(args[1]);
    if (args[2]) record = await verifyTaskKnowledge(record);
    console.log(JSON.stringify(record, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
