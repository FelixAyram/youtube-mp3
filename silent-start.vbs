' Inicia el servidor yt-dlp en segundo plano (sin ventana).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "python """ & dir & "\yt-dlp-server.py""", 0, False
