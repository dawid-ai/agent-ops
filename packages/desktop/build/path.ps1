# Adds or removes the Agent Ops bin folder in the current user's PATH. The installer runs it with
# -Action add (when the "Add the ops command to my PATH" box is checked) and the uninstaller with
# -Action remove. It edits only HKCU\Environment\Path and never the machine-wide PATH.
#
# Ownership: add appends only when no entry already names the folder (any case, with or without a
# trailing backslash), and records under HKCU\Software\Agent Ops the value it found (PathBefore)
# and the exact text it appended (PathSuffix). Remove takes out only bytes it can prove are that
# appended text: the value must still start with PathBefore + PathSuffix. If anything at or before
# that point changed, remove leaves PATH as it is. An entry the person had before installing, or
# added later, stays. The rest of
# the value (other entries, %VARIABLES%, empty segments, a trailing ';') and its registry kind are
# kept byte for byte.
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Dir,
  # Tests point these at scratch keys under HKCU\Software and skip the broadcast.
  [string]$EnvKey = 'Environment',
  [string]$StateKey = 'Software\Agent Ops',
  [switch]$NoBroadcast
)
$ErrorActionPreference = 'Stop'

$noExpand = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($EnvKey)
$exists = $key.GetValueNames() -contains 'Path'
$raw = ''
$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
if ($exists) {
  $raw = [string]$key.GetValue('Path', '', $noExpand)
  $kind = $key.GetValueKind('Path')
}

function Same([string]$a, [string]$b) {
  return [string]::Equals($a.Trim().TrimEnd('\'), $b.Trim().TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

function Broadcast {
  if ($NoBroadcast) { return }
  # Tell running programs (Explorer, new terminals) that the environment changed.
  Add-Type -Namespace AgentOps -Name Env -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
  $result = [UIntPtr]::Zero
  [void][AgentOps.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}

if ($Action -eq 'add') {
  $segments = if ($raw -eq '') { @() } else { $raw -split ';' }
  foreach ($s in $segments) {
    # Already on PATH: not ours, so record nothing and leave any earlier record as it is.
    if (Same $s $Dir) { $key.Close(); exit 0 }
  }
  $suffix = if ($raw -eq '' -or $raw.EndsWith(';')) { $Dir } else { ";$Dir" }
  $key.SetValue('Path', $raw + $suffix, $kind)
  $key.Close()
  $state = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($StateKey)
  $state.SetValue('PathEntry', $Dir, [Microsoft.Win32.RegistryValueKind]::String)
  $state.SetValue('PathBefore', $raw, [Microsoft.Win32.RegistryValueKind]::String)
  $state.SetValue('PathSuffix', $suffix, [Microsoft.Win32.RegistryValueKind]::String)
  $state.SetValue('PathCreated', [int]!$exists, [Microsoft.Win32.RegistryValueKind]::DWord)
  $state.Close()
  Broadcast
  exit 0
}

# remove
$state = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($StateKey, $true)
if ($null -eq $state -or -not ($state.GetValueNames() -contains 'PathEntry')) {
  # This install never added an entry, so there is nothing of ours to take out.
  if ($null -ne $state) { $state.Close() }
  $key.Close()
  exit 0
}
$hasBefore = $state.GetValueNames() -contains 'PathBefore'
$before = [string]$state.GetValue('PathBefore', '')
$suffix = [string]$state.GetValue('PathSuffix', '')
$created = [int]$state.GetValue('PathCreated', 0) -eq 1
foreach ($name in 'PathEntry', 'PathBefore', 'PathSuffix', 'PathCreated') { $state.DeleteValue($name, $false) }
$state.Close()

$next = $null
$owned = $before + $suffix
if ($exists -and $hasBefore -and $suffix -ne '' -and $raw.StartsWith($owned, [StringComparison]::Ordinal) -and
  ($raw.Length -eq $owned.Length -or $raw[$owned.Length] -eq ';')) {
  # The value still starts with what add left behind, and our entry ends at a separator, so the
  # bytes right after the old value are ours. Restore the old value and keep everything appended
  # later as it is, including its separators and any duplicate of our folder.
  $rest = $raw.Substring($owned.Length)
  # With no old value, the ';' that joined a later entry to ours now joins it to nothing.
  if ($before -eq '' -and $rest.StartsWith(';')) { $rest = $rest.Substring(1) }
  $next = $before + $rest
}
# Otherwise something at or before our entry changed. The value then no longer shows which segment
# add wrote: the person may have removed ours and added the same folder themselves, and that leaves
# the same bytes as an edit that kept ours. Leave PATH alone; a stale entry for a deleted folder is
# harmless, removing the person's own entry is not.
if ($null -eq $next) { $key.Close(); exit 0 }

if ($next -eq '' -and $created) {
  $key.DeleteValue('Path', $false)
} else {
  $key.SetValue('Path', $next, $kind)
}
$key.Close()
Broadcast
