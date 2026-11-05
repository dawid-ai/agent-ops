; Agent Ops installer additions (electron-builder includes this file).
; - A page with "Add the ops command to my PATH", checked by default.
; - Install adds resources\bin to the user's PATH when checked and it is not there yet;
;   uninstall removes only the entry install added (path.ps1 records it under
;   HKCU\Software\Agent Ops).
; Updates (electron-updater runs the installer with --updated) keep PATH as it is.

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var OpsPathBox
  ; Empty when the page did not show (a silent install): treated as checked.
  Var OpsPathState

  ; Updates install silently, so this page never shows for them.
  Function OpsPathPage
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 36u "Agent Ops includes the ops command, for your terminal and scripts. Agent runs that Agent Ops starts always find it; this box is only about your own terminals."
    Pop $0
    ${NSD_CreateCheckbox} 0 44u 100% 12u "Add the ops command to my PATH (this user only)"
    Pop $OpsPathBox
    ${If} $OpsPathState != ${BST_UNCHECKED}
      ${NSD_Check} $OpsPathBox
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function OpsPathLeave
    ${NSD_GetState} $OpsPathBox $OpsPathState
  FunctionEnd
!endif

!macro customPageAfterChangeDir
  Page custom OpsPathPage OpsPathLeave
!macroend

!macro customInstall
  ${IfNot} ${isUpdated}
  ${AndIf} $OpsPathState != ${BST_UNCHECKED}
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\path.ps1" -Action add -Dir "$INSTDIR\resources\bin"'
    Pop $0
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\path.ps1" -Action remove -Dir "$INSTDIR\resources\bin"'
    Pop $0
  ${EndIf}
!macroend
