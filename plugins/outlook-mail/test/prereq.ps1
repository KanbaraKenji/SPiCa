# Test harness for outlook.ps1's environment checks: stubs the registry,
# file, process and profile probes, then reports the state for each case.
#   stdin: [{"p64": path|null, "p32": path|null, "files": [paths that exist], "new": bool, "profile": bool, "running": bool}, ...]
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$env:SPICA_OUTLOOK_LOAD_ONLY = '1'
. ([scriptblock]::Create([IO.File]::ReadAllText($env:SPICA_OUTLOOK_SCRIPT, [Text.Encoding]::UTF8)))
$cases = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = @()
foreach ($c in @($cases)) {
  $script:Case = $c
  function Get-ComServerPath([string]$view) { if ($view -eq 'Registry64') { return $script:Case.p64 } else { return $script:Case.p32 } }
  function Test-FileExists([string]$path) { return ([bool]$path -and (@($script:Case.files) -contains $path)) }
  function Test-NewOutlook { return [bool]$script:Case.new }
  function Test-OutlookProfile { return [bool]$script:Case.profile }
  function Get-OutlookProcessCount { if ($script:Case.running) { return 1 } else { return 0 } }
  $p = Get-Prerequisites
  $code = $null
  try { [void](Connect-Outlook) } catch { $code = (Get-ErrorInfo $_).code }
  $out += @{ state = $p.state; classic = $p.classic_installed; path = $p.classic_path; code = $code; bits = $p.powershell_bits }
}
[Console]::Out.Write((ConvertTo-Json -InputObject $out -Depth 4 -Compress))
