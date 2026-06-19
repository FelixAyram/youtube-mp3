' Reinicia el servidor yt-dlp (mata proceso en puerto 7831 y arranca de nuevo).
Set sh = CreateObject("WScript.Shell")
Set exec = sh.Exec("cmd /c netstat -ano | findstr :7831 | findstr LISTENING")
Do While exec.Status = 0
    WScript.Sleep 100
Loop
Do While Not exec.StdOut.AtEndOfStream
    line = Trim(exec.StdOut.ReadLine())
    If line <> "" Then
        parts = Split(line)
        pid = parts(UBound(parts))
        If IsNumeric(pid) Then
            sh.Run "taskkill /PID " & pid & " /F", 0, True
        End If
    End If
Loop

Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "python """ & dir & "\yt-dlp-server.py""", 0, False
