# Nekode 截图辅助脚本：枚举窗口坐标 / 屏幕区域捕获
# 用法：
#   powershell -File shot.ps1 -Mode rects
#   powershell -File shot.ps1 -Mode capture -X 100 -Y 200 -W 400 -H 300 -Out shot.png
param(
  [string]$Mode = "rects",
  [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0,
  [string]$Out = "shot.png"
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  public struct RECT { public int L, T, R, B; }
  public static uint TargetPid;
  public static List<string> Get() {
    var res = new List<string>();
    EnumWindows((h, lp) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == TargetPid && IsWindowVisible(h)) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        RECT r; GetWindowRect(h, out r);
        res.Add(sb.ToString() + "|" + r.L + "|" + r.T + "|" + r.R + "|" + r.B);
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
if ($Mode -eq "rects") {
  [WinEnum]::SetProcessDPIAware() | Out-Null
  $p = Get-Process nekode -ErrorAction Stop | Select-Object -First 1
  [WinEnum]::TargetPid = $p.Id
  [WinEnum]::Get() | ForEach-Object { Write-Output $_ }
  exit 0
}
if ($Mode -eq "capture") {
  [WinEnum]::SetProcessDPIAware() | Out-Null
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($X, $Y, 0, 0, [System.Drawing.Size]::new($W, $H))
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "saved $Out"
  exit 0
}
