# A stand-in for the Outlook object model, for testing outlook.ps1 on a
# machine without a logged-in Outlook. Only the members outlook.ps1 uses.
# Loaded after outlook.ps1 (SPICA_OUTLOOK_LOAD_ONLY=1); replaces Connect-Outlook.
# ASCII only (see outlook.ps1).

class FakeAccessor {
  [hashtable]$props
  FakeAccessor([hashtable]$p) { $this.props = $p }
  [object] GetProperty([string]$name) {
    if ($this.props.ContainsKey($name)) { return $this.props[$name] }
    throw [System.Runtime.InteropServices.COMException]::new('property not found', [int]0x8004010F)
  }
}

class FakeRecipient {
  [int]$Type = 1
  [string]$Name
  [string]$Address
  [object]$PropertyAccessor
  FakeRecipient([string]$name, [string]$addr, [string]$smtp, [int]$type) {
    $this.Name = $name; $this.Address = $addr; $this.Type = $type
    $p = @{}
    if ($smtp) { $p['http://schemas.microsoft.com/mapi/proptag/0x39FE001F'] = $smtp }
    $this.PropertyAccessor = [FakeAccessor]::new($p)
  }
}

class FakeRecipients : System.Collections.IEnumerable {
  [System.Collections.ArrayList]$list = [System.Collections.ArrayList]::new()
  [object] Add([string]$addr) { $r = [FakeRecipient]::new($addr, $addr, $addr, 1); [void]$this.list.Add($r); return $r }
  [bool] ResolveAll() { return $true }
  [System.Collections.IEnumerator] GetEnumerator() { return $this.list.GetEnumerator() }
}

class FakeAttachment {
  [int]$Index
  [string]$FileName
  [int]$Size
  [string]$Content
  [object]$PropertyAccessor
  FakeAttachment([int]$i, [string]$name, [string]$content, [bool]$hidden) {
    $this.Index = $i; $this.FileName = $name; $this.Content = $content; $this.Size = $content.Length
    $this.PropertyAccessor = [FakeAccessor]::new(@{ 'http://schemas.microsoft.com/mapi/proptag/0x7FFE000B' = $hidden })
  }
  [void] SaveAsFile([string]$path) { [IO.File]::WriteAllText($path, $this.Content) }
}

class FakeExchangeUser { [string]$PrimarySmtpAddress; FakeExchangeUser([string]$a) { $this.PrimarySmtpAddress = $a } }
class FakeSender {
  [string]$smtp
  FakeSender([string]$a) { $this.smtp = $a }
  [object] GetExchangeUser() { return [FakeExchangeUser]::new($this.smtp) }
}

class FakeMail {
  [string]$EntryID
  [string]$Subject
  [string]$SenderName
  [string]$SenderEmailType = 'SMTP'
  [string]$SenderEmailAddress
  [object]$Sender
  [datetime]$ReceivedTime
  [bool]$UnRead
  [int]$Importance = 1
  [string]$Categories = ''
  [string]$MessageClass = 'IPM.Note'
  [string]$ConversationTopic
  [string]$Body = ''
  [string]$HTMLBody = ''
  [int]$BodyFormat = 1
  [string]$To = ''
  [string]$CC = ''
  [object]$Parent
  [object]$Attachments
  [object]$Recipients
  [object]$PropertyAccessor
  [object]$World
  [bool]$Displayed = $false
  [int]$Saves = 0

  FakeMail() { $this.Attachments = @(); $this.Recipients = [FakeRecipients]::new(); $this.PropertyAccessor = [FakeAccessor]::new(@{}) }

  [void] Save() {
    $this.Saves++
    if (-not $this.EntryID) {
      $this.EntryID = $this.World.NewId()
      $this.Parent = $this.World.Drafts
      $this.World.Drafts.Messages.Add($this)
      $this.World.Register($this)
    }
    $this.To = (@($this.Recipients.list | Where-Object { $_.Type -eq 1 } | ForEach-Object { $_.Name }) -join '; ')
    $this.CC = (@($this.Recipients.list | Where-Object { $_.Type -eq 2 } | ForEach-Object { $_.Name }) -join '; ')
  }
  [void] Display([bool]$modal) { $this.Displayed = $true }
  [object] Move([object]$target) {
    [void]$this.Parent.Messages.Remove($this)
    $this.World.Unregister($this)
    $this.EntryID = $this.World.NewId()
    $this.Parent = $target
    [void]$target.Messages.Add($this)
    $this.World.Register($this)
    return $this
  }
  [object] NewReply([bool]$all) {
    $d = [FakeMail]::new()
    $d.World = $this.World
    $d.Subject = 'RE: ' + $this.Subject
    $d.BodyFormat = 2
    $d.HTMLBody = '<html><head></head><body lang=EN><p>From: ' + $this.SenderName + '</p><p>quoted text</p></body></html>'
    [void]$d.Recipients.list.Add([FakeRecipient]::new($this.SenderName, $this.SenderEmailAddress, $this.SenderEmailAddress, 1))
    if ($all) { foreach ($r in $this.Recipients.list) { if ($r.Type -eq 2) { [void]$d.Recipients.list.Add([FakeRecipient]::new($r.Name, $r.Address, $r.Address, 2)) } } }
    return $d
  }
  [object] Reply() { return $this.NewReply($false) }
  [object] ReplyAll() { return $this.NewReply($true) }
}

class FakeRow {
  [hashtable]$data
  FakeRow([hashtable]$d) { $this.data = $d }
  [object] Item([string]$name) { return $this.data[$name] }
}

class FakeColumns {
  [System.Collections.ArrayList]$names = [System.Collections.ArrayList]::new()
  [void] RemoveAll() { $this.names.Clear() }
  [object] Add([string]$n) { [void]$this.names.Add($n); return $n }
}

class FakeTable {
  [object]$Columns = [FakeColumns]::new()
  [System.Collections.ArrayList]$items
  [int]$pos = 0
  [bool]$EndOfTable = $true
  [string]$Filter
  FakeTable($items, [string]$filter) {
    $this.items = [System.Collections.ArrayList]::new()
    foreach ($i in $items) { [void]$this.items.Add($i) }
    $this.Filter = $filter
    $this.EndOfTable = ($this.items.Count -eq 0)
  }
  [void] Sort([string]$col, [bool]$desc) {
    $sorted = @($this.items | Sort-Object -Property ReceivedTime -Descending:$desc)
    $this.items = [System.Collections.ArrayList]::new()
    foreach ($i in $sorted) { [void]$this.items.Add($i) }
  }
  [int] GetRowCount() { return $this.items.Count }
  [object] GetNextRow() {
    $m = $this.items[$this.pos]
    $this.pos++
    $this.EndOfTable = ($this.pos -ge $this.items.Count)
    $d = @{}
    foreach ($n in $this.Columns.names) {
      switch ($n) {
        'http://schemas.microsoft.com/mapi/proptag/0x5D01001F' { $d[$n] = $(if ($m.SenderEmailType -eq 'EX') { $m.Sender.smtp } else { $m.SenderEmailAddress }) }
        'urn:schemas:httpmail:hasattachment' { $d[$n] = (@($m.Attachments).Count -gt 0) }
        'urn:schemas:httpmail:textdescription' { $d[$n] = $m.Body }
        default { $d[$n] = $m.$n }
      }
    }
    return [FakeRow]::new($d)
  }
}

class FakeFolder {
  [string]$Name
  [string]$FolderPath
  [string]$EntryID
  [int]$DefaultItemType = 0
  [System.Collections.ArrayList]$Messages = [System.Collections.ArrayList]::new()
  [System.Collections.ArrayList]$Folders = [System.Collections.ArrayList]::new()
  [System.Collections.ArrayList]$Filters = [System.Collections.ArrayList]::new()
  FakeFolder([string]$name, [string]$path, [int]$type) { $this.Name = $name; $this.FolderPath = $path; $this.EntryID = 'F-' + $name; $this.DefaultItemType = $type }
  [object] GetTable() { [void]$this.Filters.Add(''); return [FakeTable]::new($this.Messages, '') }
  [object] GetTable([string]$filter) { [void]$this.Filters.Add($filter); return [FakeTable]::new($this.Messages, $filter) }
  [object] Add([string]$name, [int]$type) {
    $f = [FakeFolder]::new($name, $this.FolderPath + '\' + $name, $type)
    [void]$this.Folders.Add($f)
    return $f
  }
}

class FakeStore {
  [string]$DisplayName = 'Alex Chen'
  [string]$StoreID = 'STORE-1'
  [object]$Root
  [hashtable]$Defaults = @{}
  [object] GetRootFolder() { return $this.Root }
  [object] GetDefaultFolder([int]$n) {
    if ($this.Defaults.ContainsKey($n)) { return $this.Defaults[$n] }
    throw [System.Runtime.InteropServices.COMException]::new('no such default folder', [int]0x8004010F)
  }
}

class FakeWorld {
  [int]$next = 100
  [hashtable]$byId = @{}
  [object]$Drafts
  [object]$Store
  [string] NewId() { $this.next++; return 'E' + $this.next }
  [void] Register([object]$m) { $this.byId[$m.EntryID] = $m }
  [void] Unregister([object]$m) { $this.byId.Remove($m.EntryID) }
}

class FakeNamespace {
  [object]$World
  [object]$DefaultStore
  [object[]]$Stores
  [object] GetItemFromID([string]$id) { return $this.Lookup($id) }
  [object] GetItemFromID([string]$id, [string]$store) { return $this.Lookup($id) }
  [object] Lookup([string]$id) {
    if ($id -eq 'guarded') { throw [System.Runtime.InteropServices.COMException]::new('operation aborted', [int]0x80004004) }
    if ($id -eq 'busy') { throw [System.Runtime.InteropServices.COMException]::new('call rejected', [int]0x80010001) }
    if ($this.World.byId.ContainsKey($id)) { return $this.World.byId[$id] }
    throw [System.Runtime.InteropServices.COMException]::new('not found', [int]0x8004010F)
  }
}

class FakeApp {
  [string]$Version = '16.0.0.0'
  [object]$World
  [object] CreateItem([int]$type) {
    $m = [FakeMail]::new(); $m.World = $this.World; $m.BodyFormat = 2
    $m.HTMLBody = '<html><body></body></html>'
    return $m
  }
}

# Outlook exposes these as properties; PowerShell classes need type data for computed ones.
Update-TypeData -TypeName FakeFolder -MemberType ScriptProperty -MemberName UnReadItemCount -Value { @($this.Messages | Where-Object { $_.UnRead }).Count } -Force
Update-TypeData -TypeName FakeFolder -MemberType ScriptProperty -MemberName Items -Value { [pscustomobject]@{ Count = $this.Messages.Count } } -Force

function New-FakeMail($world, $folder, [string]$subject, [string]$from, [string]$addr, [string]$when, [bool]$unread, [string]$body) {
  $m = [FakeMail]::new()
  $m.World = $world
  $m.EntryID = $world.NewId()
  $m.Subject = $subject; $m.ConversationTopic = $subject
  $m.SenderName = $from; $m.SenderEmailAddress = $addr
  $m.ReceivedTime = [datetime]::ParseExact($when, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
  $m.UnRead = $unread; $m.Body = $body; $m.HTMLBody = '<html><body><p>' + $body + '</p></body></html>'
  $m.Parent = $folder
  [void]$m.Recipients.list.Add([FakeRecipient]::new('Alex Chen', '/O=EXAMPLE/OU=X/CN=RECIPIENTS/CN=ALEX', 'alex@example.test', 1))
  [void]$folder.Messages.Add($m)
  $world.Register($m)
  return $m
}

function New-FakeOutlook {
  $w = [FakeWorld]::new()
  $store = [FakeStore]::new()
  $root = [FakeFolder]::new('Top', '\\Alex Chen', 0)
  $store.Root = $root
  $inbox = $root.Add('Inbox', 0)
  $proj = $inbox.Add('Projects', 0)
  $drafts = $root.Add('Drafts', 0)
  $sent = $root.Add('Sent Items', 0)
  [void]$root.Add('Calendar', 1)
  $store.Defaults[6] = $inbox; $store.Defaults[16] = $drafts; $store.Defaults[5] = $sent
  $w.Drafts = $drafts; $w.Store = $store

  $a = New-FakeMail $w $inbox 'Quote Q-7 for flyers' 'Priya Nair' 'priya@print.example.test' '2026-11-08 16:40' $true 'Quote attached. Valid 14 days.'
  $a.Attachments = @([FakeAttachment]::new(1, 'quote-Q-7.csv', "item,price`nflyer,10`n", $false), [FakeAttachment]::new(2, 'image001.png', 'png', $true))
  $a.Categories = 'Open House, Quotes'
  $a.Importance = 2
  [void]$a.Recipients.list.Add([FakeRecipient]::new('Mei Lin', 'mei@example.test', 'mei@example.test', 2))
  $b = New-FakeMail $w $inbox 'Kickoff agenda' 'Jordan Lee' '/O=EXAMPLE/OU=X/CN=RECIPIENTS/CN=JORDAN' '2026-11-09 09:00' $true ('Agenda line ' * 30)
  $b.SenderEmailType = 'EX'; $b.Sender = [FakeSender]::new('jordan@example.test'); $b.MessageClass = 'IPM.Schedule.Meeting.Request'
  $c = New-FakeMail $w $inbox "Lunch on Friday? It's on me" 'Sam Ortiz' 'sam@example.test' '2026-11-01 12:00' $false 'Old message.'
  $d = New-FakeMail $w $proj 'Sitemap' 'Jordan Lee' 'jordan@example.test' '2026-11-05 10:00' $false 'Home, Work, About.'

  $ns = [FakeNamespace]::new()
  $ns.World = $w; $ns.DefaultStore = $store; $ns.Stores = @($store)
  $app = [FakeApp]::new(); $app.World = $w
  return @{ app = $app; ns = $ns; world = $w; ids = @{ quote = $a.EntryID; agenda = $b.EntryID; lunch = $c.EntryID; sitemap = $d.EntryID } }
}

$script:Fake = New-FakeOutlook
function Connect-Outlook { return @{ app = $script:Fake.app; ns = $script:Fake.ns } }
