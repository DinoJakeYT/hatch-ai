# Saves a PNG of the biggest visible window belonging to a process (or its child processes,
# e.g. the console host of a console program). Used by Hatch's preview tool.
param([int]$ProcessId, [string]$Out)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class HatchWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Find(HashSet<uint> pids) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (pids.Contains(p) && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
        if (a > bestArea) { bestArea = a; best = h; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@

[void][HatchWin]::SetProcessDPIAware()
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
[void]$pids.Add([uint32]$ProcessId)
Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" | ForEach-Object { [void]$pids.Add([uint32]$_.ProcessId) }

$h = [IntPtr]::Zero
for ($i = 0; $i -lt 10 -and $h -eq [IntPtr]::Zero; $i++) {
  $h = [HatchWin]::Find($pids)
  if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 300 }
}
if ($h -eq [IntPtr]::Zero) { [Console]::Error.WriteLine('The program has no visible window.'); exit 2 }

$r = New-Object HatchWin+RECT
[void][HatchWin]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][HatchWin]::PrintWindow($h, $hdc, 2)   # 2 = full content, works for most modern windows
$g.ReleaseHdc($hdc)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"$w x $ht"
