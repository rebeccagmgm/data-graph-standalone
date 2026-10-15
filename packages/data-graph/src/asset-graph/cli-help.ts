export const CLI_HELP = {
  schemaVersion: "1.0.0",
  name: "lineage-graph",
  description:
    "Query the published Titans OTC graph; read-only commands never generate projections.",
  commands: {
    status: "Publication version and coverage.",
    metrics:
      "Read-only published INDEX metrics, without Neo4j; [--gap-layer boundary|actionable|material|unclassified --reason-code CODE OR --terminal-role REFERENCE_CONFIG --offset 0 --limit 25]",
    "query-read-candidates":
      "--read-occurrence-id <id> [--consumer-task-id <id>] [--publication-version <version>] [--offset 0 --limit 25]; reads only the pinned published INDEX.",
    search: "--text <task/table/name> [--limit 25 --offset 0]",
    fields:
      "--task-id <id> OR --table <qualified-name> [--limit 100 --offset 0]",
    trace:
      "--task-id <id> --column <name> [--write-id <id>] OR --node-id <id> OR --table <name> --column <name>; --layer field|table|schedule --direction up|down --depth 4 --limit 150 [--confirmed-only]",
    detail:
      "--task-id <id> [--column <name>] [--write-id <id>] [--limit 25 --offset 0]",
    explain:
      "--task-id <id> --write-id <exact write id> --column <name> [--publication-version <version>] [--max-depth 32 --max-nodes 500 --max-edges 1000]; complete processing stages from frozen published evidence, including conditions and UNION branches.",
    processing:
      "--task-id <id> [--text <formula fragment>] [--relation-id <exact relation id>] [--offset 0 --limit 25] [--sql --slot query --line-start 1 --line-count 80]",
    compare: "--task-ids 86840,86841,86842,220650 --column init_nom_prin",
    help: "This contract. No database connection required.",
  },
  examples: [
    "lineage-graph.ps1 search --text t98_otc_deri_comp_sale_info",
    "lineage-graph.ps1 trace --table pdata_n.t98_otc_deri_comp_sale_info --layer table --depth 1",
    "lineage-graph.ps1 trace --task-id 86842 --column init_nom_prin --depth 6",
    "lineage-graph.ps1 processing --task-id 93338 --text dyna_nom_prin",
  ],
  limits: {
    searchMax: 100,
    fieldsMax: 1000,
    traceEdgesMax: 1000,
    traceDepthMax: 12,
    processingMax: 100,
    sqlLinesMax: 300,
  },
  fieldSemantics: {
    VALUE: "Task-local value source",
    CONTINUES: "Confirmed field continuation",
    CANDIDATE:
      "Candidate with retained partition status; use --confirmed-only to omit",
    CONDITION:
      "Only returned in processing/control details; excluded from value traversal",
  },
  coverageDisposition: {
    DATA_LINEAGE: "Task has projected SQL field lineage",
    EXPECTED_SCHEDULE_REFERENCE:
      "Task type is schedule-only by design (qualityTask, checkAlert, exeSql, …); not a material gap",
    MATERIAL_GAP:
      "Task should have field lineage but pack/facts/schema are missing",
  },
  coverageStatus: {
    PROJECTED: "Field lineage available",
    SCHEDULE_ONLY:
      "Horae schedule neighbors only; may be expected or a material gap — see coverageDisposition",
    COLLECTION_FAILED:
      "No schedule context and no facts, or projection failed — see failureReason and coverageDisposition",
  },
  exitCodes: {
    0: "success",
    1: "query or publication error",
    2: "invalid arguments",
  },
  metaTiming: {
    elapsedMs:
      "Milliseconds from assetGraphMain() entry until data is ready, including command-specific dynamic imports. Excludes static module loading, JSON.stringify/console output, and driver.close(). Not directly comparable with pre-lazy-loading values.",
  },
} as const;
