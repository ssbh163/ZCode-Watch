# zcode-watch 桌面悬浮窗(Windows PowerShell 5.1+,零依赖,纯 UI 壳)
# 布局沿用 zcode-usage-widget 的规格:372 宽 / 18 内边距 / 16 圆角 / 6px 胶囊进度条 / macOS 标签色阶梯
# 本脚本只做渲染,不含任何取数/计算逻辑——全部来自 node zcode-watch.mjs --json(单份正本,两端数字永不打架)
# 配色与 ZCode 外观主题保持一致(探测 ZCode 窗口实际配色,深浅同步);ZCODE_WATCH_THEME=light|dark 可强制
# 生命周期与插件绑定:由插件 SessionStart hook 拉起,插件卸载(本脚本被删)后自动退出
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# 单实例保护 + 唤醒通道:必须放在 Add-Type/XAML 等耗时初始化之前,
# 否则主实例启动头几秒内到达的唤醒信号(事件尚未创建/轮询尚未开始)会被静默丢弃
$mutex = New-Object System.Threading.Mutex($false, 'Global\ZCode-Watch-Widget')
$ownsMutex = $false
try { $ownsMutex = $mutex.WaitOne(0) } catch { $ownsMutex = $true }
if (-not $ownsMutex) {
  if ($args -notcontains 'NoShowIfExists') {
    # 手动再次启动:唤醒已有窗口(事件由主实例拿到互斥量后立即创建,无需重试)
    try { [System.Threading.EventWaitHandle]::OpenExisting('Global\ZCode-Watch-Widget-Show').Set() | Out-Null } catch { }
  }
  exit
}
# 主实例:立即创建唤醒事件(initialState=false,不会误触发)
$showEvt = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, 'Global\ZCode-Watch-Widget-Show')

# 唤醒文件:SessionStart hook(新会话)touch 一次,运行中的实例轮询到 mtime 变化即唤回
$wakeFile = Join-Path $env:USERPROFILE '.zcode\scripts\zcode-watch-widget.wake'
$script:lastWake = if (Test-Path $wakeFile) { (Get-Item $wakeFile).LastWriteTimeUtc } else { [datetime]::MinValue }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -Namespace CWNative -Name Hotkey -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
[DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
'@
# 磨砂玻璃背景(Windows BlurBehind + 浅黑色调)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CWComposition {
  [StructLayout(LayoutKind.Sequential)]
  public struct AccentPolicy { public int AccentState; public int AccentFlags; public uint GradientColor; public int AnimationId; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WCAD { public int Attrib; public IntPtr Data; public int SizeOfData; }
  [DllImport("user32.dll")]
  public static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WCAD data);
  public static bool EnableBlur(IntPtr hwnd, uint gradient) {
    var ap = new AccentPolicy { AccentState = 3, AccentFlags = 2, GradientColor = gradient };
    IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(ap));
    Marshal.StructureToPtr(ap, p, false);
    var d = new WCAD { Attrib = 19, Data = p, SizeOfData = Marshal.SizeOf(ap) };
    int r = SetWindowCompositionAttribute(hwnd, ref d);
    Marshal.FreeHGlobal(p);
    return r != 0;
  }
}
'@

# ZCode 窗口像素探测:PrintWindow 截 ZCode 主窗口,采样最左侧栏亮度判断深浅
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace CWNative -Name ZCodeProbe -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

# 查询脚本定位:优先 ~/.zcode/scripts(独立安装),其次插件缓存(随插件分发)
$scriptPath = Join-Path $env:USERPROFILE '.zcode\scripts\zcode-watch.mjs'
if (-not (Test-Path $scriptPath)) {
  $cached = Get-ChildItem "$env:USERPROFILE\.zcode\cli\plugins\cache\*\zcode-watch\*\skills\zcode-watch\scripts\zcode-watch.mjs" |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($cached) { $scriptPath = $cached.FullName }
}

# node 定位:兼容自启/非 shell 环境 PATH 为空的情况(避坑清单:内置多候选路径探测)
function Resolve-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe')
  )
  if ($env:NVM_HOME) { $candidates += (Join-Path $env:NVM_HOME 'node.exe') }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return 'node'
}
$script:nodeExe = Resolve-Node

$configFile = Join-Path $env:USERPROFILE '.zcode\zcode-watch.json'
$configDir = Split-Path $configFile

# 面板 372 宽;pad 18;圆角 16;内容宽 = 372 - 36 - 20(窗口 Margin 10×2)= 316
$xamlText = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="zcode-watch" Topmost="True" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" ShowInTaskbar="False" ResizeMode="NoResize" ShowActivated="False"
        Width="372" SizeToContent="Height">
  <Window.Resources>
    <!-- 配色走 DynamicResource,Apply-Theme 按 ZCode 外观整体切换;卡片 XAML 片段同样引用这些资源 -->
    <SolidColorBrush x:Key="LabelBrush" Color="#FFFFFF"/>
    <SolidColorBrush x:Key="SecondaryBrush" Color="#A6FFFFFF"/>
    <SolidColorBrush x:Key="ValueBrush" Color="#8CFFFFFF"/>
    <SolidColorBrush x:Key="TertiaryBrush" Color="#80FFFFFF"/>
    <SolidColorBrush x:Key="QuaternaryBrush" Color="#24FFFFFF"/>
    <SolidColorBrush x:Key="TrackBrush" Color="#24FFFFFF"/>
    <SolidColorBrush x:Key="SeparatorBrush" Color="#2EFFFFFF"/>
    <SolidColorBrush x:Key="BorderBrushR" Color="#1AFFFFFF"/>
    <SolidColorBrush x:Key="RootBgBrush" Color="#E014171C"/>
  </Window.Resources>
  <Window.ContextMenu>
    <ContextMenu>
      <MenuItem x:Name="MenuRefresh" Header="立即刷新"/>
      <MenuItem x:Name="MenuConfig" Header="编辑 Key 配置…"/>
      <Separator/>
      <MenuItem x:Name="MenuExit" Header="退出"/>
    </ContextMenu>
  </Window.ContextMenu>
  <Border x:Name="Root" CornerRadius="16" Background="{DynamicResource RootBgBrush}" BorderBrush="{DynamicResource BorderBrushR}" BorderThickness="1"
          Margin="10" Padding="18">
    <DockPanel>
      <Grid DockPanel.Dock="Top" Height="20">
        <TextBlock Text="⚡ zcode-watch" FontSize="14" FontWeight="Bold" Foreground="{DynamicResource LabelBrush}"
                   VerticalAlignment="Center"/>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
          <TextBlock x:Name="BtnRefresh" Text="↻" FontSize="13" Foreground="{DynamicResource SecondaryBrush}" Cursor="Hand"
                     ToolTip="立即刷新" Margin="0,0,12,0"/>
          <TextBlock x:Name="BtnClose" Text="✕" FontSize="13" FontWeight="Medium" Foreground="{DynamicResource SecondaryBrush}"
                     Cursor="Hand" ToolTip="收起面板(Ctrl+Shift+G 唤回;右键菜单可退出)"/>
        </StackPanel>
      </Grid>
      <TextBlock x:Name="Meta" Text="正在读取…" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}"
                 DockPanel.Dock="Top" Margin="0,1,0,10"/>
      <TextBlock x:Name="Hint" Text="总使用额度 = 非高峰×1 + 高峰×3 · Ctrl+Shift+G 唤出 / 收起 · 拖拽可移动" FontSize="10"
                 Foreground="{DynamicResource QuaternaryBrush}" DockPanel.Dock="Bottom" Margin="0,10,0,0" TextWrapping="Wrap"/>
      <ScrollViewer VerticalScrollBarVisibility="Auto">
        <StackPanel x:Name="CardsHost"/>
      </ScrollViewer>
    </DockPanel>
  </Border>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Parse($xamlText)
$el = { param($n) $win.FindName($n) }
$Meta = & $el 'Meta'
$Hint = & $el 'Hint'
$BtnRefresh = & $el 'BtnRefresh'
$BtnClose = & $el 'BtnClose'
$CardsHost = & $el 'CardsHost'

# 初始位置:主屏右上角;有保存位置且在屏幕范围内则恢复
$posFile = Join-Path $env:USERPROFILE '.zcode\scripts\zcode-watch-widget.pos.json'
$wa = [System.Windows.SystemParameters]::WorkArea
$win.Left = $wa.Right - $win.Width - 26
$win.Top = $wa.Top + 16
$win.MaxHeight = $wa.Height - 40
if (Test-Path $posFile) {
  try {
    $pos = Get-Content $posFile -Raw | ConvertFrom-Json
    if ($pos.Left -is [double] -and $pos.Top -is [double] -and
        $pos.Left -ge ($wa.Left - 20) -and ($pos.Left + $win.Width) -le ($wa.Right + 20) -and
        $pos.Top -ge ($wa.Top - 20) -and ($pos.Top + 200) -le ($wa.Bottom + 20)) {
      $win.Left = $pos.Left
      $win.Top = $pos.Top
    }
  } catch { }
}
function Save-Pos {
  try {
    @{ Left = $win.Left; Top = $win.Top } | ConvertTo-Json | Set-Content -Path $posFile -Encoding ASCII
  } catch { }
}

$bc = New-Object System.Windows.Media.BrushConverter
function Brush($hex) { $script:bc.ConvertFromString($hex) }

# —— 主题:与 ZCode 外观保持一致(像素探测 ZCode 主窗口侧边栏),不读写任何 Windows 主题设置 ——
$themeOverride = $env:ZCODE_WATCH_THEME
$themes = @{
  dark = @{ Label='#FFFFFF'; Secondary='#A6FFFFFF'; Value='#8CFFFFFF'; Tertiary='#80FFFFFF'
            Quaternary='#24FFFFFF'; Track='#24FFFFFF'; Separator='#2EFFFFFF'; Border='#1AFFFFFF'
            RootSemi='#E014171C'; RootOpaque='#F01C1F24'; BlurTint=0x991A1A18 }
  light = @{ Label='#FF1D1D1F'; Secondary='#A63C3C43'; Value='#A63C3C43'; Tertiary='#803C3C43'
             Quaternary='#993C3C43'; Track='#293C3C43'; Separator='#2E3C3C43'; Border='#1A000000'
             RootSemi='#E0F2F2F4'; RootOpaque='#F0F2F2F5'; BlurTint=0x99E9EAEC }
}
$script:lastKnownDark = $null
function Get-IsDarkTheme {
  if ($themeOverride -eq 'dark') { return $true }
  if ($themeOverride -eq 'light') { return $false }
  try {
    $z = Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($z) {
      $r = New-Object CWNative.ZCodeProbe+RECT
      [CWNative.ZCodeProbe]::GetWindowRect($z.MainWindowHandle, [ref]$r) | Out-Null
      $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
      if ($w -gt 100 -and $h -gt 100) {
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $ok = [CWNative.ZCodeProbe]::PrintWindow($z.MainWindowHandle, $hdc, 2)
        $g.ReleaseHdc($hdc); $g.Dispose()
        if ($ok) {
          $lum = 0.0; $n = 0
          foreach ($fx in @(0.012, 0.018, 0.024)) {
            foreach ($fy in @(0.3, 0.5, 0.7)) {
              $c = $bmp.GetPixel([int]($w * $fx), [int]($h * $fy))
              $lum += 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B; $n++
            }
          }
          $bmp.Dispose()
          $script:lastKnownDark = (($lum / $n) -lt 110)
          return $script:lastKnownDark
        }
        $bmp.Dispose()
      }
    }
  } catch { }
  if ($null -ne $script:lastKnownDark) { return $script:lastKnownDark }
  try {
    $v = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Themes\Personalize').GetValue('AppsUseLightTheme')
    return ($v -eq 0)
  } catch { return $true }
}
$script:blurOk = $true
function Apply-Theme {
  $script:theme = if (Get-IsDarkTheme) { $themes.dark } else { $themes.light }
  $map = @{ Label='LabelBrush'; Secondary='SecondaryBrush'; Value='ValueBrush'
            Tertiary='TertiaryBrush'; Quaternary='QuaternaryBrush'; Track='TrackBrush'
            Separator='SeparatorBrush'; Border='BorderBrushR' }
  foreach ($k in $map.Keys) {
    $b = $win.Resources[$map[$k]]
    # 注意:改 .Color 必须用 ColorConverter(返回 Color);BrushConverter 返回 Brush 会抛异常
    if ($b) { $b.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($script:theme[$k]) }
  }
  $rootBrush = $win.Resources['RootBgBrush']
  if ($rootBrush) {
    # 磨砂可用时半透明底让窗口后的模糊透出来;失败则退不透明底
    $bg = if ($script:blurOk) { $script:theme.RootSemi } else { $script:theme.RootOpaque }
    $rootBrush.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($bg)
  }
  if ($script:helper -and $script:blurOk) {
    [CWComposition]::EnableBlur($script:helper.Handle, $script:theme.BlurTint) | Out-Null
  }
}

# 用量越高越醒目:<60 绿,>=60 橙,>=85 红(与 zcode-usage 阈值一致)
function RateColor([double]$p) {
  if ($p -ge 85) { '#FF5A5A' } elseif ($p -ge 60) { '#FFA94D' } else { '#33B873' }
}
# Fmt.tokens:1.25 亿 / 9.2 万
function Format-Tokens([double]$v) {
  if ($v -ge 1e8) { return '{0:F2} 亿' -f ($v / 1e8) }
  if ($v -ge 1e4) { return '{0:F1} 万' -f ($v / 1e4) }
  return '{0:N0}' -f $v
}
function Esc([string]$s) { [System.Security.SecurityElement]::Escape($s) }

# 卡片内容宽 = 372 - 20(窗口 Margin) - 36(Root Padding)= 316
$trackWidth = 316.0

# —— 单张卡片:XAML 片段(值烘焙进去,文本经 XML 转义;DynamicResource 挂进窗口树后自动解析) ——
function New-KeyCard($k) {
  $p = [Math]::Min(100, [Math]::Max(0, [double]$k.percent))
  $col = RateColor $p
  $fillW = [Math]::Max(6, [Math]::Round($trackWidth * $p / 100))
  $pctTxt = '{0:F1}' -f [double]$k.percent
  $quota = Format-Tokens ([double]$k.monthlyQuota)
  $weighted = Format-Tokens ([double]$k.weightedTotal)
  $peak = Format-Tokens ([double]$k.peakTokens)
  $offPeak = Format-Tokens ([double]$k.offPeakTokens)
  $resetDays = [Math]::Max(0, [Math]::Ceiling(([datetime]$k.resetDate - (Get-Date)).TotalDays))
  $name = Esc ("● {0} {1}" -f $k.name, $k.keyTail)
  $level = Esc ([string]$k.level)

  $banner = ''
  if ($k.error) {
    $hint = if ($k.error -match '401|令牌|token|鉴权|验证') { 'Key 无效或非 Coding Plan 专用 Key,请检查配置文件' }
            else { '稍后自动重试;持续失败请检查网络' }
    $banner = ("<TextBlock Text=`"⚠ 查询失败:{0}`" FontSize=`"10.5`" FontWeight=`"SemiBold`" Foreground=`"#FF5A5A`" Margin=`"0,4,0,2`" TextWrapping=`"Wrap`"/>" -f (Esc $k.error)) +
              ("<TextBlock Text=`"{0}`" FontSize=`"10`" Foreground=`"{DynamicResource QuaternaryBrush}`" Margin=`"0,0,0,2`" TextWrapping=`"Wrap`"/>" -f (Esc $hint))
  } elseif ($k.exhausted) {
    $banner = '<TextBlock Text="⚠ 本月已用满 100%,建议删除该 Key" FontSize="10.5" FontWeight="SemiBold" Foreground="#FF5A5A" Margin="0,4,0,2"/>'
  }
  $inc = ''
  if (-not $k.error -and $k.incomplete) {
    $inc = '<TextBlock Text="账单数据量过大,本轮未拉完,断点续拉中" FontSize="10" Foreground="{DynamicResource QuaternaryBrush}" Margin="0,3,0,0" TextWrapping="Wrap"/>'
  }

  $xaml = @"
<StackPanel xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Margin="0,2,0,0">
  <Grid Height="18">
    <TextBlock Text="$name" FontSize="12.5" FontWeight="SemiBold" Foreground="{DynamicResource LabelBrush}" VerticalAlignment="Center"/>
    <TextBlock Text="[$level]" FontSize="11" FontWeight="Bold" Foreground="{DynamicResource SecondaryBrush}" HorizontalAlignment="Right" VerticalAlignment="Center"/>
  </Grid>
  $banner
  <Grid Height="16" Margin="0,4,0,0">
    <TextBlock Text="月度用量" FontSize="11.5" FontWeight="Medium" Foreground="{DynamicResource TertiaryBrush}" VerticalAlignment="Center"/>
    <TextBlock Text="已用 $pctTxt%" FontSize="12" FontWeight="Bold" HorizontalAlignment="Right" VerticalAlignment="Center" Foreground="$col"/>
  </Grid>
  <Border Height="6" CornerRadius="3" Background="{DynamicResource TrackBrush}" Margin="0,4,0,4" ClipToBounds="True">
    <Border Height="6" CornerRadius="3" HorizontalAlignment="Left" Width="$fillW" Background="$col"/>
  </Border>
  <Grid Height="15">
    <TextBlock Text="总使用额度" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" VerticalAlignment="Center"/>
    <TextBlock Text="$weighted / $quota" FontSize="10.5" HorizontalAlignment="Right" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
  </Grid>
  <Grid Height="15">
    <TextBlock Text="高峰期使用(×3 折算)" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" VerticalAlignment="Center"/>
    <TextBlock Text="$peak" FontSize="10.5" HorizontalAlignment="Right" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
  </Grid>
  <Grid Height="15">
    <TextBlock Text="非高峰期使用" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" VerticalAlignment="Center"/>
    <TextBlock Text="$offPeak" FontSize="10.5" HorizontalAlignment="Right" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
  </Grid>
  <TextBlock Text="↻ $($k.resetDate) 重置 · 还剩 $resetDays 天" FontSize="10" Foreground="{DynamicResource QuaternaryBrush}" Margin="0,3,0,0"/>
  $inc
</StackPanel>
"@
  return [Windows.Markup.XamlReader]::Parse($xaml)
}

function New-Separator {
  $xaml = '<Rectangle xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Height="1" Fill="{DynamicResource SeparatorBrush}" Margin="0,10,0,10"/>'
  [Windows.Markup.XamlReader]::Parse($xaml)
}

function New-MessageCard([string]$title, [string]$body, [string]$color) {
  $xaml = @"
<StackPanel xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
  <TextBlock Text="$(Esc $title)" FontSize="12.5" FontWeight="SemiBold" Foreground="$color" Margin="0,4,0,4" TextWrapping="Wrap"/>
  <TextBlock Text="$(Esc $body)" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" TextWrapping="Wrap"/>
</StackPanel>
"@
  [Windows.Markup.XamlReader]::Parse($xaml)
}

function Clear-Cards { $CardsHost.Children.Clear() }

function Show-EmptyState {
  Clear-Cards
  [void]$CardsHost.Children.Add((New-MessageCard '未配置 API Key' `
    ("配置文件:$configFile`n右键菜单 → 「编辑 Key 配置…」可创建并打开;`n也可在 ZCode 对话里说:「添加一个 zcode-watch key,名字 xx,Key 是 xxx」" ) `
    '#FFA94D'))
}

# —— 刷新:node 查询 → 解析 → 重建卡片(Key 不经命令行参数,引擎自己读配置文件) ——
function Invoke-Refresh {
  $Meta.Text = '正在读取…'
  $raw = (& $script:nodeExe $scriptPath --json 2>&1 | Out-String).Trim()
  $d = $null
  if ($raw) { try { $d = $raw | ConvertFrom-Json } catch { $d = $null } }
  if (-not $d) {
    Clear-Cards
    $msg = if ($raw) { ($raw -split "`r?`n")[0] } else { '无输出(找不到 node 或查询脚本?)' }
    [void]$CardsHost.Children.Add((New-MessageCard '⚠ 读取失败' $msg '#FF5A5A'))
    $Meta.Text = '读取失败 · 点 ↻ 重试'
    return
  }
  if ($d.error) {
    Clear-Cards
    [void]$CardsHost.Children.Add((New-MessageCard '⚠ 配置文件有误' $d.error '#FF5A5A'))
    $Meta.Text = '配置错误 · 右键 → 编辑 Key 配置'
    return
  }
  if ($d.empty -or -not $d.keys -or @($d.keys).Count -eq 0) {
    Show-EmptyState
    $Meta.Text = 'zcode-watch'
    return
  }
  Clear-Cards
  $keys = @($d.keys)
  $ok = @($keys | Where-Object { -not $_.error }).Count
  $first = $true
  foreach ($k in $keys) {
    if (-not $first) { [void]$CardsHost.Children.Add((New-Separator)) }
    $first = $false
    [void]$CardsHost.Children.Add((New-KeyCard $k))
  }
  $Meta.Text = ('{0} 月 · {1} 把 Key({2} 把正常)· 更新于 {3}' -f $d.month, $keys.Count, $ok, (Get-Date -Format 'HH:mm:ss'))
}

# —— 右键「编辑 Key 配置…」:配置不存在时先写模板(UTF-8 BOM,引擎会剥),再用记事本打开 ——
function Ensure-Config {
  if (Test-Path $configFile) { return }
  if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
  $tpl = @'
{
  "keys": [
    {
      "id": "key-1",
      "name": "主力",
      "provider": "bigmodel",
      "apiKey": "在这里粘贴你的 API Key",
      "monthlyQuota": 1750000000
    }
  ]
}
'@
  [IO.File]::WriteAllText($configFile, $tpl, (New-Object System.Text.UTF8Encoding $true))
}
function Edit-Config {
  Ensure-Config
  try { Start-Process notepad -ArgumentList "`"$configFile`"" } catch { }
}

# 自动刷新间隔(分钟);手动 ↗ 实时。110 分钟 + 保底 2h 拉取窗 → 自动刷新也只拉增量 1 页
$refreshMinutes = 110
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMinutes($refreshMinutes)
$timer.Add_Tick({ Invoke-Refresh })

# ↻ 刷新,✕ 收起(隐藏不退出);悬停变亮
$BtnRefresh.Add_MouseEnter({ $BtnRefresh.Foreground = Brush $script:theme.Label })
$BtnRefresh.Add_MouseLeave({ $BtnRefresh.Foreground = Brush $script:theme.Secondary })
$BtnRefresh.Add_MouseLeftButtonUp({ Invoke-Refresh })
$BtnClose.Add_MouseEnter({ $BtnClose.Foreground = Brush '#FF5A5A' })
$BtnClose.Add_MouseLeave({ $BtnClose.Foreground = Brush $script:theme.Secondary })
$BtnClose.Add_MouseLeftButtonUp({ $win.Hide() })

# 拖动(避开 ↻/✕ 按钮,否则 DragMove 会吞掉按钮的点击——zcode-usage 0.0.5 的教训)
$win.Add_MouseLeftButtonDown({
  $src = $_.OriginalSource
  if ($src -ne $BtnRefresh -and $src -ne $BtnClose) { $win.DragMove(); Save-Pos }
})
$win.Add_Closing({ Save-Pos })

# 全局快捷键(可改):0x2=Ctrl,0x1=Alt,0x4=Shift 可组合;G=0x47
# 默认 Ctrl+Shift+G——Ctrl+G 已被 zcode-usage 悬浮窗占用,两窗共存时避免热键冲突
$hotkeyModifiers = 0x6
$hotkeyKey = 0x47
$script:helper = $null
$win.Add_SourceInitialized({
  $script:helper = New-Object System.Windows.Interop.WindowInteropHelper($win)
  $hkOk = [CWNative.Hotkey]::RegisterHotKey($script:helper.Handle, 0xB001, $script:hotkeyModifiers, $script:hotkeyKey)
  if (-not $hkOk) {
    # 全局热键被其他软件占用:醒目提示,避免"按了没反应"无从排查
    $mods = (@{ 1 = 'Alt'; 2 = 'Ctrl'; 4 = 'Shift'; 8 = 'Win' }[[int]$script:hotkeyModifiers])
    $key = [char]$script:hotkeyKey
    $Hint.Text = "⚠ ${mods}+$key 已被其他软件占用,快捷键不可用(改键:脚本顶部 `\$hotkeyKey)"
    $Hint.Foreground = Brush '#FFA94D'
  }
  # 磨砂玻璃:BlurBehind + 随主题的深/浅 tint;失败回退不透明底色
  $Root = $win.FindName('Root')
  $script:blurOk = [CWComposition]::EnableBlur($script:helper.Handle, $script:theme.BlurTint)
  if (-not $script:blurOk) {
    $Root.Background = Brush $script:theme.RootOpaque
  }
  $src = [System.Windows.Interop.HwndSource]::FromHwnd($script:helper.Handle)
  $src.AddHook({
    param($hwnd, $msg, $wParam, $lParam, [ref]$handled)
    if ($msg -eq 0x0312 -and $wParam.ToInt64() -eq 0xB001) {
      if ($win.IsVisible) { $win.Hide() } else { $win.Show() }
      $handled.Value = $true
    }
    [IntPtr]::Zero
  })
})

# ZCode 启动检测:none→running 才算启动(避免 Electron 子进程重建误唤起)
$script:zcodeWasRunning = [bool](Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue)
$zcodeTimer = New-Object System.Windows.Threading.DispatcherTimer
$zcodeTimer.Interval = [TimeSpan]::FromMilliseconds(2000)
$zcodeTimer.Add_Tick({
  # ZCode 外观跟随:探测 ZCode 主窗口配色,变化即整体换肤
  $dark = Get-IsDarkTheme
  if ($dark -ne $script:isDark) {
    $script:isDark = $dark
    Apply-Theme
    try {
      Add-Content -Path (Join-Path $env:USERPROFILE '.zcode\scripts\zcode-watch-theme.log') `
        -Value ("{0} -> {1}" -f (Get-Date -Format 'MM/dd HH:mm:ss'), $(if ($dark) { 'dark' } else { 'light' }))
    } catch { }
  }
  # 自存活检测:本脚本被删(= 插件已卸载)则自行退出
  if ($PSCommandPath -and -not (Test-Path $PSCommandPath)) { [Environment]::Exit(0) }
  $running = [bool](Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue)
  if ($running -and -not $script:zcodeWasRunning) {
    # ZCode 启动:唤起
    if (-not $win.IsVisible) { $win.Show() }
    $win.Activate()
  }
  elseif (-not $running -and $script:zcodeWasRunning) {
    # ZCode 完全退出:悬浮窗随之退出(生命周期完全绑定)
    try { if ($script:helper) { [CWNative.Hotkey]::UnregisterHotKey($script:helper.Handle, 0xB001) | Out-Null } } catch { }
    $timer.Stop()
    $win.Close()
    [Environment]::Exit(0)
  }
  $script:zcodeWasRunning = $running
})
$zcodeTimer.Start()

# 唤醒轮询:双通道 —— 命名事件(手动再次启动)+ 唤醒文件(SessionStart hook touch)
$wakeTimer = New-Object System.Windows.Threading.DispatcherTimer
$wakeTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$wakeTimer.Add_Tick({
  $wake = $showEvt.WaitOne(0)
  $wi = Get-Item $wakeFile -ErrorAction SilentlyContinue
  if ($wi -and $wi.LastWriteTimeUtc -gt $script:lastWake) {
    $script:lastWake = $wi.LastWriteTimeUtc
    $wake = $true
  }
  # 只负责唤回;已可见时不 Activate,避免抢焦点(Topmost 本就在最上层)
  if ($wake -and -not $win.IsVisible) { $win.Show() }
})
$wakeTimer.Start()

$menuItems = @{}
foreach ($mi in $win.ContextMenu.Items) {
  if ($mi -is [System.Windows.Controls.MenuItem]) { $menuItems[$mi.Header] = $mi }
}
$menuItems['立即刷新'].Add_Click({ Invoke-Refresh })
$menuItems['编辑 Key 配置…'].Add_Click({ Edit-Config })
$menuItems['退出'].Add_Click({
  try { if ($script:helper) { [CWNative.Hotkey]::UnregisterHotKey($script:helper.Handle, 0xB001) | Out-Null } } catch { }
  $timer.Stop(); $win.Close(); [Environment]::Exit(0)
})

# 应用主题(与 ZCode 外观一致);此后 zcodeTimer 每 2 秒探测 ZCode 配色并跟随切换
$script:isDark = Get-IsDarkTheme
try { Apply-Theme } catch {
  try { Add-Content (Join-Path $env:USERPROFILE '.zcode\scripts\zcode-watch-theme.log') ("startup Apply-Theme THREW: " + $_.Exception.Message) } catch { }
}

Invoke-Refresh
$timer.Start()
$win.Show()
[System.Windows.Threading.Dispatcher]::Run()
