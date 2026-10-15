param([Parameter(ValueFromRemainingArguments=$true)][string[]]$QueryArgs)
$graphRepoRoot = Split-Path -Parent $PSScriptRoot
$graphCliPath = Join-Path $graphRepoRoot 'packages/data-graph/src/asset-graph/cli.ts'
$graphTsxLoader = Join-Path $graphRepoRoot 'node_modules/tsx/dist/loader.mjs'
& node --import ([System.Uri]$graphTsxLoader).AbsoluteUri $graphCliPath @QueryArgs
exit $LASTEXITCODE

