param(
  [Parameter(Mandatory = $true)]
  [int]$TargetProcessId,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [int]$CropLeft = 10,
  [int]$CropTop = 0,
  [int]$CropRight = 10,
  [int]$CropBottom = 10
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class QaasTerminalCaptureNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out RECT rectangle);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@

$previousDpiContext = [QaasTerminalCaptureNative]::SetThreadDpiAwarenessContext(
  [IntPtr](-4)
)
$target = Get-Process -Id $TargetProcessId -ErrorAction Stop
if ($target.ProcessName -ne 'pwsh') {
  throw "Capture target must be pwsh; found '$($target.ProcessName)'."
}
if ($target.MainWindowHandle -eq [IntPtr]::Zero) {
  throw 'Capture target does not expose a visible main window.'
}
if ($target.MainWindowTitle -notlike 'QaaS Plugin demo - *') {
  throw "Unexpected capture target title: '$($target.MainWindowTitle)'."
}

[QaasTerminalCaptureNative]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
[QaasTerminalCaptureNative]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900

$rectangle = New-Object QaasTerminalCaptureNative+RECT
if (
  -not [QaasTerminalCaptureNative]::GetWindowRect(
    $target.MainWindowHandle,
    [ref]$rectangle
  )
) {
  throw 'Could not resolve the terminal window rectangle.'
}

$windowWidth = $rectangle.Right - $rectangle.Left
$windowHeight = $rectangle.Bottom - $rectangle.Top
$width = $windowWidth - $CropLeft - $CropRight
$height = $windowHeight - $CropTop - $CropBottom
if ($width -lt 640 -or $height -lt 480) {
  throw "Capture target is unexpectedly small: ${width}x${height}."
}

if (
  $CropLeft -lt 0 -or
  $CropTop -lt 0 -or
  $CropRight -lt 0 -or
  $CropBottom -lt 0 -or
  $rectangle.Left + $CropLeft -lt 0 -or
  $rectangle.Top + $CropTop -lt 0 -or
  $windowWidth -gt 2000 -or
  $windowHeight -gt 1200
) {
  throw 'Capture target bounds are outside the privacy-safe capture envelope.'
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [System.IO.Path]::GetDirectoryName($resolvedOutput)
if (-not [System.IO.Directory]::Exists($outputDirectory)) {
  throw "Output directory does not exist: '$outputDirectory'."
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen(
    $rectangle.Left + $CropLeft,
    $rectangle.Top + $CropTop,
    0,
    0,
    (New-Object System.Drawing.Size $width, $height),
    [System.Drawing.CopyPixelOperation]::SourceCopy
  )
  $bitmap.Save(
    $resolvedOutput,
    [System.Drawing.Imaging.ImageFormat]::Png
  )
}
finally {
  $graphics.Dispose()
  $bitmap.Dispose()
  if ($previousDpiContext -ne [IntPtr]::Zero) {
    [QaasTerminalCaptureNative]::SetThreadDpiAwarenessContext(
      $previousDpiContext
    ) | Out-Null
  }
}

[pscustomobject]@{
  captureMechanism = 'DPI-aware System.Drawing.CopyFromScreen over visible GetWindowRect bounds with explicit privacy crop'
  capturedAt = [DateTimeOffset]::Now.ToString('o')
  processId = $target.Id
  processName = $target.ProcessName
  windowTitle = $target.MainWindowTitle
  width = $width
  height = $height
  crop = [pscustomobject]@{
    left = $CropLeft
    top = $CropTop
    right = $CropRight
    bottom = $CropBottom
  }
  output = $resolvedOutput
} | ConvertTo-Json -Depth 3
