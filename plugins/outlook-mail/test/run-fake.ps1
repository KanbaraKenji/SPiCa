# Test harness: load outlook.ps1's functions, swap Outlook for the fake one,
# run a list of requests in one process and print every answer as JSON.
#   env SPICA_OUTLOOK_SCRIPT = path to outlook.ps1, SPICA_FAKE_SCRIPT = fake-outlook.ps1
#   stdin: [{"op": "...", "args": {...}}, ...]; "$name" string values are replaced by the fake ids.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$env:SPICA_OUTLOOK_LOAD_ONLY = '1'
. ([scriptblock]::Create([IO.File]::ReadAllText($env:SPICA_OUTLOOK_SCRIPT, [Text.Encoding]::UTF8)))
. ([scriptblock]::Create([IO.File]::ReadAllText($env:SPICA_FAKE_SCRIPT, [Text.Encoding]::UTF8)))

function Expand-Ids($v) {
  if ($v -is [string] -and $v.StartsWith('$') -and $script:Fake.ids.ContainsKey($v.Substring(1))) { return $script:Fake.ids[$v.Substring(1)] }
  if ($v -is [array]) { return , @($v | ForEach-Object { Expand-Ids $_ }) }
  if ($null -ne $v -and $v.GetType().Name -eq 'PSCustomObject') { foreach ($p in $v.PSObject.Properties) { $p.Value = Expand-Ids $p.Value }; return $v }
  return $v
}

$reqs = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = @()
foreach ($r in @($reqs)) {
  try {
    $a = Expand-Ids $r.args
    $out += @{ ok = $true; result = (Invoke-Op ([string]$r.op) $a) }
  } catch {
    $out += @{ ok = $false; error = (Get-ErrorInfo $_) }
  }
}
$drafts = @($script:Fake.world.Drafts.Messages | ForEach-Object { @{ subject = $_.Subject; html = $_.HTMLBody; body = $_.Body; to = $_.To; cc = $_.CC; displayed = $_.Displayed } })
$filters = @{ inbox = @($script:Fake.world.Store.Defaults[6].Filters) }
[Console]::Out.Write((ConvertTo-Json -InputObject @{ ids = $script:Fake.ids; results = $out; drafts = $drafts; filters = $filters } -Depth 8 -Compress))
