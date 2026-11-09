# Spica Outlook worker. One request per process, started by outlook-backend.js
# with powershell.exe -NoProfile -NonInteractive (windowsHide, no console).
#   stdin : {"op": "...", "args": {...}}           (UTF-8 JSON)
#   stdout: {"ok": true, "result": {...}}  or  {"ok": false, "error": {"code", "hresult", "detail"}}
# Talks to the running classic Outlook through its COM object model.
# Rules: never send mail (no Send call anywhere), never write mail content to
# stderr, never start Outlook ourselves (a missing profile would open the
# profile wizard). Keep this file ASCII-only: Windows PowerShell 5.1 reads
# BOM-less files as ANSI.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Aliases = @{ inbox = 6; drafts = 16; sent = 5; deleted = 3; junk = 23; outbox = 4 }
$PR_SMTP = 'http://schemas.microsoft.com/mapi/proptag/0x5D01001F'            # sender SMTP address
$PR_RECIP_SMTP = 'http://schemas.microsoft.com/mapi/proptag/0x39FE001F'      # recipient SMTP address
$PR_ATT_HIDDEN = 'http://schemas.microsoft.com/mapi/proptag/0x7FFE000B'
$PR_ATT_CID = 'http://schemas.microsoft.com/mapi/proptag/0x3712001F'
# HRESULTs that must never be swallowed (security prompt, Outlook busy or gone).
$FatalHResults = @(0x80004004, 0x80070005, 0x80010001, 0x8001010A, 0x800706BA, 0x800706BE, 0x80010108) | ForEach-Object { [int]$_ }

function New-MailError([string]$Code, [string]$Detail) {
  $e = New-Object System.Exception ("SPICA:" + $Code)
  $e.Data['spica_code'] = $Code
  if ($Detail) { $e.Data['spica_detail'] = $Detail }
  return $e
}

function Get-HResult($ex) {
  $e = $ex
  while ($e) {
    if ($e -is [System.Runtime.InteropServices.COMException]) { return [int]$e.ErrorCode }
    $e = $e.InnerException
  }
  $e = $ex
  while ($e) {
    $h = [int]$e.HResult
    # 0x8013xxxx are .NET / PowerShell's own codes, not Outlook's.
    if ($h -ne 0 -and (($h -band 0xFFFF0000) -ne [int]0x80130000)) { return $h }
    $e = $e.InnerException
  }
  return $null
}

function Test-Fatal($er) {
  $h = Get-HResult $er.Exception
  return ($null -ne $h -and $FatalHResults -contains $h)
}

function Get-ErrorInfo($er) {
  $ex = $er.Exception
  $code = $null; $detail = $null
  $e = $ex
  while ($e) {
    if ($e.Data -and $e.Data.Contains('spica_code')) { $code = [string]$e.Data['spica_code']; $detail = [string]$e.Data['spica_detail']; break }
    $e = $e.InnerException
  }
  if (-not $code -and ([string]$ex.Message) -match 'language mode') { $code = 'POWERSHELL_RESTRICTED' }
  $h = $null
  if (-not $code) { $h = Get-HResult $ex }
  $info = @{ code = $code; detail = $detail }
  if ($null -ne $h) { $info.hresult = ('0x{0:X8}' -f $h) }
  if (-not $code -and $null -eq $h) { $info.kind = $ex.GetType().Name }   # type name only, never the message
  return $info
}

# ---------- environment checks ----------

function Test-OutlookProfile {
  foreach ($v in '16.0', '15.0') {
    $k = "HKCU:\Software\Microsoft\Office\$v\Outlook\Profiles"
    if ((Test-Path $k) -and @(Get-ChildItem $k -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
  }
  return $false
}

# The exe that COM would start for Outlook.Application, read from one
# registry view ('Registry64' or 'Registry32'). $null when not registered.
# A registration can outlive the program (uninstall leftovers, or a 64-bit
# entry pointing at a folder that does not exist), so callers check the file.
function Get-ComServerPath([string]$view) {
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot, [Microsoft.Win32.RegistryView]$view)
    $ck = $base.OpenSubKey('Outlook.Application\CLSID')
    if ($null -eq $ck) { return $null }
    $clsid = [string]$ck.GetValue('')
    $ls = $base.OpenSubKey("CLSID\$clsid\LocalServer32")
    if ($null -eq $ls) { return $null }
    $cmd = ([string]$ls.GetValue('')).Trim()
  } catch { return $null }
  if (-not $cmd) { return $null }
  if ($cmd.StartsWith('"')) { $end = $cmd.IndexOf('"', 1); if ($end -gt 1) { return $cmd.Substring(1, $end - 1) } return $null }
  $m = [regex]::Match($cmd, '^(.*?\.exe)\b', 'IgnoreCase')
  if ($m.Success) { return $m.Groups[1].Value }
  return $cmd
}

function Test-FileExists([string]$path) { return ([bool]$path -and [IO.File]::Exists($path)) }

# The new Outlook for Windows (olk.exe, a Store app) has no COM interface.
function Test-NewOutlook {
  if (Test-FileExists (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\olk.exe')) { return $true }
  try { return (@(Get-AppxPackage -Name 'Microsoft.OutlookForWindows' -ErrorAction Stop).Count -gt 0) } catch { return $false }
}

function Get-OutlookProcessCount { return @(Get-Process -Name OUTLOOK -ErrorAction SilentlyContinue).Count }

function Get-Prerequisites {
  $p64 = Get-ComServerPath 'Registry64'
  $p32 = Get-ComServerPath 'Registry32'
  $ok64 = Test-FileExists $p64
  $ok32 = Test-FileExists $p32
  $p = @{
    language = $ExecutionContext.SessionState.LanguageMode.ToString()
    classic_installed = ($ok64 -or $ok32)
    classic_path = $(if ($ok64) { $p64 } elseif ($ok32) { $p32 } else { $null })
    powershell_bits = $(if ([Environment]::Is64BitProcess) { 64 } else { 32 })
    # 64-bit PowerShell reads the 64-bit registration; when only the 32-bit one
    # points at a real file, the worker must run in 32-bit PowerShell instead.
    needs_32bit = ([Environment]::Is64BitProcess -and -not $ok64 -and $ok32)
    profile = (Test-OutlookProfile)
    running = ((Get-OutlookProcessCount) -gt 0)
  }
  $p.new_outlook_installed = $(if ($p.classic_installed) { $null } else { Test-NewOutlook })
  $p.state = $(
    if ($p.language -ne 'FullLanguage') { 'restricted' }
    elseif (-not $p.classic_installed) { if ($p.new_outlook_installed) { 'new_outlook_only' } else { 'not_installed' } }
    elseif ($p.needs_32bit) { 'needs_32bit' }
    elseif (-not $p.profile) { 'no_profile' }
    elseif (-not $p.running) { 'not_running' }
    else { 'ready' }
  )
  return $p
}

$StateCodes = @{
  restricted = 'POWERSHELL_RESTRICTED'
  not_installed = 'OUTLOOK_NOT_INSTALLED'
  new_outlook_only = 'OUTLOOK_NEW_ONLY'
  needs_32bit = 'NEED_32BIT_POWERSHELL'
  no_profile = 'OUTLOOK_NO_PROFILE'
  not_running = 'OUTLOOK_NOT_RUNNING'
}

function Connect-Outlook {
  $p = Get-Prerequisites
  if ($p.state -ne 'ready') { throw (New-MailError $StateCodes[$p.state]) }
  for ($i = 1; ; $i++) {
    try {
      # Outlook is single-instance: with it running this attaches, it does not start a new one.
      $app = New-Object -ComObject Outlook.Application
      $ns = $app.GetNamespace('MAPI')
      return @{ app = $app; ns = $ns }
    } catch {
      $h = Get-HResult $_.Exception
      if ($i -lt 3 -and ($h -eq [int]0x80010001 -or $h -eq [int]0x8001010A)) { Start-Sleep -Milliseconds 500; continue }
      throw
    }
  }
}

# ---------- helpers ----------

function Format-Time($v) {
  if ($null -eq $v -or -not ($v -is [datetime])) { return $null }
  if ($v.Year -ge 4500) { return $null }   # Outlook's "none" date (unsent drafts)
  return $v.ToString('yyyy-MM-ddTHH:mm:sszzz', [Globalization.CultureInfo]::InvariantCulture)
}

function Get-Importance($n) { switch ([int]$n) { 0 { 'low' } 2 { 'high' } default { 'normal' } } }

function Get-Kind([string]$cls) {
  if ($cls -like 'IPM.Schedule.Meeting*') { return 'meeting' }
  if ($cls -like 'REPORT.*') { return 'report' }
  if ($cls -like 'IPM.Note*' -or $cls -eq '' -or $cls -eq 'IPM') { return 'mail' }
  return 'other'
}

function Split-List([string]$s) {
  # The leading comma keeps a one- or zero-item list an array (PowerShell unrolls function output).
  if (-not $s) { return , @() }
  return , @($s -split '\s*[;,]\s*' | Where-Object { $_ -ne '' })
}

function Get-Preview([string]$s) {
  if (-not $s) { return '' }
  $flat = ($s -replace '\s+', ' ').Trim()
  if ($flat.Length -gt 120) { return $flat.Substring(0, 119) + [char]0x2026 }
  return $flat
}

function Get-RelPath($folder) {
  # FolderPath is "\\<store>\Inbox\Sub"; answer "Inbox/Sub".
  $fp = [string]$folder.FolderPath
  $fp = $fp -replace '^\\\\[^\\]*\\?', ''
  return ($fp -replace '\\', '/')
}

function Get-Store($ns, [string]$mailbox) {
  if (-not $mailbox) { return $ns.DefaultStore }
  foreach ($st in $ns.Stores) { if ($st.DisplayName -ieq $mailbox) { return $st } }
  throw (New-MailError 'FOLDER_NOT_FOUND' ('mailbox:' + $mailbox))
}

function Resolve-Folder($ns, [string]$path, [string]$mailbox) {
  $store = Get-Store $ns $mailbox
  $parts = @(([string]$path) -split '[\\/]' | Where-Object { $_ -ne '' })
  if ($parts.Count -eq 0) { $parts = @('inbox') }
  $first = $parts[0].ToLowerInvariant()
  if ($Aliases.ContainsKey($first)) {
    $f = $store.GetDefaultFolder($Aliases[$first])
    $rest = @($parts | Select-Object -Skip 1)
  } else {
    $f = $store.GetRootFolder()
    $rest = $parts
  }
  foreach ($p in $rest) {
    $next = $null
    foreach ($c in $f.Folders) { if ($c.Name -ieq $p) { $next = $c; break } }
    if ($null -eq $next) { throw (New-MailError 'FOLDER_NOT_FOUND' $path) }
    $f = $next
  }
  return $f
}

function Get-MailItem($ns, [string]$id) {
  try { return $ns.GetItemFromID($id) } catch { if (Test-Fatal $_) { throw } }
  foreach ($st in $ns.Stores) {
    try { return $ns.GetItemFromID($id, $st.StoreID) } catch { if (Test-Fatal $_) { throw } }
  }
  throw (New-MailError 'MESSAGE_NOT_FOUND')
}

function Get-SenderAddress($item) {
  if ([string]$item.SenderEmailType -eq 'EX') {
    try { $u = $item.Sender.GetExchangeUser(); if ($u) { return [string]$u.PrimarySmtpAddress } } catch { if (Test-Fatal $_) { throw } }
    try { return [string]$item.PropertyAccessor.GetProperty($PR_SMTP) } catch { if (Test-Fatal $_) { throw } }
    return ''
  }
  return [string]$item.SenderEmailAddress
}

function Get-Recipients($item, [int]$type) {
  $out = New-Object System.Collections.Generic.List[string]
  $n = 0
  foreach ($r in $item.Recipients) {
    if ([int]$r.Type -ne $type) { continue }
    if (++$n -gt 50) { break }
    $addr = $null
    try { $addr = [string]$r.PropertyAccessor.GetProperty($PR_RECIP_SMTP) } catch { if (Test-Fatal $_) { throw } }
    if (-not $addr) { $addr = [string]$r.Address }
    if ($addr -and $addr -notlike '/O=*' -and $addr -ne $r.Name) { $out.Add(('{0} <{1}>' -f $r.Name, $addr)) } else { $out.Add([string]$r.Name) }
  }
  return , $out.ToArray()
}

# ---------- file names (same rules as files.js) ----------

function Get-SafeFileName([string]$name) {
  $n = ([string]$name) -replace '\\', '/'
  $n = $n.Substring($n.LastIndexOf('/') + 1)
  $n = $n -replace '[<>:"/\\|?*\x00-\x1f]', '_'
  $n = ($n -replace '[. ]+$', '').Trim()
  if (-not $n) { $n = 'attachment' }
  $ext = [IO.Path]::GetExtension($n)
  $stem = $n.Substring(0, $n.Length - $ext.Length)
  if ($stem -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])$') { $n = '_' + $n }
  if ($n.Length -gt 150) { $n = $n.Substring(0, 150 - $ext.Length) + $ext }
  return $n
}

function Get-UniquePath([string]$folder, [string]$name, [bool]$overwrite, $taken) {
  $safe = Get-SafeFileName $name
  $ext = [IO.Path]::GetExtension($safe)
  $stem = $safe.Substring(0, $safe.Length - $ext.Length)
  $candidate = $safe
  for ($i = 1; ; $i++) {
    $full = [IO.Path]::Combine($folder, $candidate)
    $key = $full.ToLowerInvariant()
    if (-not $taken.Contains($key) -and ($overwrite -or -not [IO.File]::Exists($full))) { [void]$taken.Add($key); return $full }
    $candidate = '{0} ({1}){2}' -f $stem, $i, $ext
  }
}

function ConvertTo-HtmlText([string]$s) {
  return ([System.Net.WebUtility]::HtmlEncode($s) -replace "`r?`n", '<br>')
}

# ---------- operations ----------

function Invoke-Status {
  $p = Get-Prerequisites
  if ($p.state -eq 'needs_32bit') { throw (New-MailError 'NEED_32BIT_POWERSHELL') }
  $o = @{}
  foreach ($k in 'state', 'classic_installed', 'classic_path', 'new_outlook_installed', 'profile', 'running', 'language', 'powershell_bits') { $o[$k] = $p[$k] }
  if ($null -eq $o.new_outlook_installed) { $o.new_outlook_installed = (Test-NewOutlook) }
  $r = @{ mode = 'real'; outlook = $o; mailboxes = @() }
  if ($p.state -eq 'ready') {
    $c = Connect-Outlook
    $r.outlook.version = [string]$c.app.Version
    $defId = [string]$c.ns.DefaultStore.StoreID
    $boxes = @()
    foreach ($st in $c.ns.Stores) { $boxes += @{ name = [string]$st.DisplayName; default = ([string]$st.StoreID -eq $defId) } }
    $r.mailboxes = $boxes
  }
  return $r
}

function Invoke-ListFolders($a) {
  $c = Connect-Outlook
  $store = Get-Store $c.ns $a.mailbox
  $aliasById = @{}
  foreach ($k in $Aliases.Keys) {
    try { $aliasById[[string]$store.GetDefaultFolder($Aliases[$k]).EntryID] = $k } catch { if (Test-Fatal $_) { throw } }
  }
  $list = New-Object System.Collections.ArrayList
  $walk = {
    param($folder, $depth)
    foreach ($f in $folder.Folders) {
      if ([int]$f.DefaultItemType -ne 0) { continue }   # mail folders only
      $row = @{ path = (Get-RelPath $f); unread = [int]$f.UnReadItemCount; total = [int]$f.Items.Count }
      $alias = $aliasById[[string]$f.EntryID]
      if ($alias) { $row.alias = $alias }
      [void]$list.Add($row)
      if ($depth -lt 5 -and $list.Count -lt 500) { & $walk $f ($depth + 1) }
    }
  }
  & $walk $store.GetRootFolder() 1
  return @{ mailbox = [string]$store.DisplayName; folders = $list.ToArray() }
}

function Get-DaslFilter($a) {
  $parts = @()
  $esc = { param($s) ([string]$s).Replace("'", "''") }
  if ($a.unread_only) { $parts += '"urn:schemas:httpmail:read" = 0' }
  if ($a.has_attachments) { $parts += '"urn:schemas:httpmail:hasattachment" = 1' }
  if ($a.from) {
    $q = & $esc $a.from
    $parts += "(""urn:schemas:httpmail:fromname"" LIKE '%$q%' OR ""urn:schemas:httpmail:fromemail"" LIKE '%$q%')"
  }
  if ($a.query) {
    $q = & $esc $a.query
    $parts += "(""urn:schemas:httpmail:subject"" LIKE '%$q%' OR ""urn:schemas:httpmail:fromname"" LIKE '%$q%' OR ""urn:schemas:httpmail:textdescription"" LIKE '%$q%')"
  }
  if ($parts.Count -eq 0) { return $null }
  return '@SQL=' + ($parts -join ' AND ')
}

function Invoke-ListMessages($a) {
  $c = Connect-Outlook
  $folder = Resolve-Folder $c.ns $a.folder $a.mailbox
  $filter = Get-DaslFilter $a
  $table = if ($filter) { $folder.GetTable($filter) } else { $folder.GetTable() }
  $cols = $table.Columns
  $cols.RemoveAll()
  foreach ($n in 'EntryID', 'Subject', 'SenderName', 'SenderEmailAddress', 'ReceivedTime', 'UnRead', 'Importance', 'Categories', 'MessageClass') { [void]$cols.Add($n) }
  $opt = @{}
  foreach ($n in $PR_SMTP, 'urn:schemas:httpmail:hasattachment', 'urn:schemas:httpmail:textdescription') {
    try { [void]$cols.Add($n); $opt[$n] = $true } catch { if (Test-Fatal $_) { throw }; $opt[$n] = $false }
  }
  $table.Sort('[ReceivedTime]', $true)
  # Dates are compared here, not in the filter: filter date literals depend on the Windows locale.
  $since = if ($a.since) { [DateTimeOffset]::Parse($a.since, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime } else { $null }
  $until = if ($a.until) { [DateTimeOffset]::Parse($a.until, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime } else { $null }
  $offset = [int]$a.offset; $limit = [int]$a.limit
  $rows = New-Object System.Collections.ArrayList
  $total = 0
  $fast = ($null -eq $since -and $null -eq $until)
  $rowCount = [int]$table.GetRowCount()
  while (-not $table.EndOfTable) {
    $row = $table.GetNextRow()
    $rt = $row.Item('ReceivedTime')
    if ($null -ne $until -and $rt -is [datetime] -and $rt.Year -lt 4500 -and $rt -gt $until) { continue }
    if ($null -ne $since -and (-not ($rt -is [datetime]) -or $rt.Year -ge 4500 -or $rt -lt $since)) {
      if ($rt -is [datetime] -and $rt.Year -lt 4500) { break } else { continue }
    }
    if ($total -ge $offset -and $rows.Count -lt $limit) {
      $addr = ''
      if ($opt[$PR_SMTP]) { $addr = [string]$row.Item($PR_SMTP) }
      if (-not $addr) { $addr = [string]$row.Item('SenderEmailAddress'); if ($addr -like '/O=*') { $addr = '' } }
      $cats = Split-List ([string]$row.Item('Categories'))
      [void]$rows.Add(@{
        id = [string]$row.Item('EntryID')
        kind = (Get-Kind ([string]$row.Item('MessageClass')))
        from_name = [string]$row.Item('SenderName')
        from_address = $addr
        subject = [string]$row.Item('Subject')
        received = (Format-Time $rt)
        unread = [bool]$row.Item('UnRead')
        has_attachments = $(if ($opt['urn:schemas:httpmail:hasattachment']) { [bool]$row.Item('urn:schemas:httpmail:hasattachment') } else { $null })
        importance = (Get-Importance $row.Item('Importance'))
        categories = $cats
        preview = $(if ($opt['urn:schemas:httpmail:textdescription']) { Get-Preview ([string]$row.Item('urn:schemas:httpmail:textdescription')) } else { '' })
      })
    }
    $total++
    if ($fast -and $rows.Count -ge $limit) { $total = $rowCount; break }
  }
  $next = $null
  if ($offset + $rows.Count -lt $total) { $next = $offset + $rows.Count }
  return @{ folder = (Get-RelPath $folder); total = $total; offset = $offset; next_offset = $next; messages = $rows.ToArray() }
}

function Invoke-ReadMessage($a) {
  $c = Connect-Outlook
  $item = Get-MailItem $c.ns $a.id
  $full = if ($a.format -eq 'html') { [string]$item.HTMLBody } else { [string]$item.Body }
  $max = [int]$a.max_chars
  $atts = New-Object System.Collections.ArrayList
  foreach ($att in $item.Attachments) {
    $inline = $false
    try {
      $pa = $att.PropertyAccessor
      if ($pa.GetProperty($PR_ATT_HIDDEN)) { $inline = $true }
    } catch { if (Test-Fatal $_) { throw } }
    [void]$atts.Add(@{ index = [int]$att.Index; name = [string]$att.FileName; size = [int]$att.Size; inline = $inline })
  }
  return @{
    id = [string]$item.EntryID
    kind = (Get-Kind ([string]$item.MessageClass))
    folder = (Get-RelPath $item.Parent)
    from_name = [string]$item.SenderName
    from_address = (Get-SenderAddress $item)
    to = (Get-Recipients $item 1)
    cc = (Get-Recipients $item 2)
    subject = [string]$item.Subject
    received = (Format-Time $item.ReceivedTime)
    unread = [bool]$item.UnRead
    importance = (Get-Importance $item.Importance)
    categories = (Split-List ([string]$item.Categories))
    conversation = [string]$item.ConversationTopic
    format = $a.format
    body = $(if ($full.Length -gt $max) { $full.Substring(0, $max) } else { $full })
    truncated = ($full.Length -gt $max)
    attachments = $atts.ToArray()
  }
}

function Invoke-MarkRead($a) {
  $c = Connect-Outlook
  $want = [bool]$a.unread
  $items = @(foreach ($id in $a.ids) { Get-MailItem $c.ns $id })
  $changed = 0
  foreach ($it in $items) {
    if ([bool]$it.UnRead -ne $want) { $changed++; $it.UnRead = $want; $it.Save() }
  }
  return @{ changed = $changed; unread = $want }
}

function Invoke-MoveMessages($a) {
  $c = Connect-Outlook
  $target = Resolve-Folder $c.ns $a.folder $a.mailbox
  $items = @(foreach ($id in $a.ids) { @{ id = [string]$id; item = (Get-MailItem $c.ns $id) } })
  $moved = @()
  foreach ($x in $items) {
    $m = $x.item.Move($target)
    $moved += @{ old_id = $x.id; id = [string]$m.EntryID }
  }
  return @{ folder = (Get-RelPath $target); moved = $moved }
}

function Invoke-SaveAttachments($a) {
  $c = Connect-Outlook
  $item = Get-MailItem $c.ns $a.id
  $all = @(foreach ($att in $item.Attachments) { $att })
  if ($a.names) {
    $picked = @(foreach ($n in $a.names) {
      $hit = $null
      foreach ($att in $all) { if ([string]$att.FileName -ieq $n) { $hit = $att; break } }
      if ($null -eq $hit) { throw (New-MailError 'ATTACHMENT_NOT_FOUND' $n) }
      $hit
    })
  } else { $picked = $all }
  [void][IO.Directory]::CreateDirectory($a.dest_folder)
  $taken = New-Object 'System.Collections.Generic.HashSet[string]'
  $saved = @()
  foreach ($att in $picked) {
    $path = Get-UniquePath $a.dest_folder ([string]$att.FileName) ([bool]$a.overwrite) $taken
    $att.SaveAsFile($path)
    $saved += @{ name = [string]$att.FileName; path = $path; size = [int64]([IO.FileInfo]::new($path).Length) }
  }
  return @{ folder = $a.dest_folder; saved = $saved }
}

function Invoke-CreateDraft($a) {
  $c = Connect-Outlook
  if ($a.reply_to) {
    $orig = Get-MailItem $c.ns $a.reply_to
    $d = if ($a.reply_all) { $orig.ReplyAll() } else { $orig.Reply() }
  } else {
    $d = $c.app.CreateItem(0)
  }
  foreach ($r in @($a.to)) { if ($r) { $x = $d.Recipients.Add([string]$r); $x.Type = 1 } }
  foreach ($r in @($a.cc)) { if ($r) { $x = $d.Recipients.Add([string]$r); $x.Type = 2 } }
  if ($a.subject) { $d.Subject = [string]$a.subject }
  $text = [string]$a.body
  if ([int]$d.BodyFormat -eq 2) {
    # HTML: insert above the quoted message so its formatting survives.
    $html = [string]$d.HTMLBody
    $block = '<div>' + (ConvertTo-HtmlText $text) + '</div><br>'
    $m = [regex]::Match($html, '(?is)<body[^>]*>')
    if ($m.Success) { $html = $html.Substring(0, $m.Index + $m.Length) + $block + $html.Substring($m.Index + $m.Length) } else { $html = $block + $html }
    $d.HTMLBody = $html
  } else {
    $old = [string]$d.Body
    $d.Body = $(if ($old) { $text + "`r`n`r`n" + $old } else { $text })
  }
  [void]$d.Recipients.ResolveAll()
  $d.Save()
  $opened = $false
  if ($a.open_window) { $d.Display($false); $opened = $true }
  return @{
    id = [string]$d.EntryID
    folder = (Get-RelPath $d.Parent)
    subject = [string]$d.Subject
    to = (Split-List ([string]$d.To))
    cc = (Split-List ([string]$d.CC))
    opened_window = $opened
    sent = $false
  }
}

function Invoke-Op([string]$op, $a) {
  switch ($op) {
    'status' { return Invoke-Status }
    'listFolders' { return Invoke-ListFolders $a }
    'listMessages' { return Invoke-ListMessages $a }
    'readMessage' { return Invoke-ReadMessage $a }
    'markRead' { return Invoke-MarkRead $a }
    'moveMessages' { return Invoke-MoveMessages $a }
    'saveAttachments' { return Invoke-SaveAttachments $a }
    'createDraft' { return Invoke-CreateDraft $a }
    default { throw (New-MailError 'INVALID_ARGUMENT' ('unknown op ' + $op)) }
  }
}

function Write-Response($obj) {
  [Console]::Out.Write((ConvertTo-Json -InputObject $obj -Depth 8 -Compress))
}

# Tests load the functions only.
if ($env:SPICA_OUTLOOK_LOAD_ONLY -eq '1') { return }

try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $result = Invoke-Op ([string]$req.op) $req.args
  Write-Response @{ ok = $true; result = $result }
} catch {
  Write-Response @{ ok = $false; error = (Get-ErrorInfo $_) }
}
