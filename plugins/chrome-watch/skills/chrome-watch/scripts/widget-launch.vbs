' chrome-watch widget launcher (called by plugin SessionStart hook; locates script relative to itself)
' NoShowIfExists: exit silently if a widget instance is already running (session wake is done by
' widget-launch.mjs touching the wake file); otherwise launch hidden and show it.
Dim dir, shell
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\chrome-watch-widget.ps1"" -NoShowIfExists", 0, False
