; The installer's last page and shortcuts (included by electron-builder: electron-builder.yml nsis.include).
;
; Shortcuts: the Start menu and desktop shortcuts are always made, with no box for them (as before rc.3);
; electron-builder makes them (createStartMenuShortcut / createDesktopShortcut). Installing again over an
; installed copy, electron-builder keeps them as they are (KeepShortcuts): one the user deleted stays deleted.
; Once, on the first install of this installer over an older one, a missing Start menu or desktop shortcut is
; made again: rc.3's last page had boxes for them, and leaving one unticked deleted the shortcut, so people
; were left with no Start menu entry (and the app could not be found by searching). The registry value
; ShortcutsRestored marks that this was done; it is read in customInit, because installing over a copy runs
; its uninstaller, which deletes the install key, before the files are copied.
;
; The last page: under 「运行 <name>」 one box, 开机时启动.
; - A first install turns it on (the sign-in entry is written here), so the box starts ticked; leaving the page
;   any way keeps it. Unticking it and pressing 完成 undoes it.
; - Installing again over an installed copy: the box starts as things are now (autostart turned off in 设置
;   stays off unless ticked here); the sign-in entry is only written on a first install.
; - An update (the app runs the installer with --updated /S) shows no page and changes none of this.
; - Uninstalling removes the sign-in entry (electron-builder removes the shortcuts); an update's run of the old
;   uninstaller (--updated) keeps it.
;
; The sign-in entry is the one the app's own switch reads and writes (main/autostart.ts, Electron's
; setLoginItemSettings): HKCU ...\Run, value named after the app id (= its AppUserModelID), data
; "<exe>" --autostart. HKCU only: no administrator rights.

!define SPICA_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define SPICA_STARTUP_APPROVED "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var spicaHadInstall
  Var spicaRestored
  Var spicaApplied
  Var spicaAutostartBox

  !macro customInit
    ; An installed copy already here (this user): then the box shows how things are, nothing is added.
    ReadRegStr $spicaHadInstall HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $spicaRestored HKCU "${INSTALL_REGISTRY_KEY}" ShortcutsRestored
  !macroend

  !macro customInstall
    ${ifNot} ${isUpdated}
      ${if} $spicaHadInstall == ""
        WriteRegStr HKCU "${SPICA_RUN_KEY}" "${APP_ID}" '"$appExe" --autostart'
      ${endIf}
      ; Over an older copy, once: shortcuts that copy's last page may have deleted come back.
      ${if} $spicaRestored == ""
        ${ifNot} ${FileExists} "$newStartMenuLink"
          CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
          ClearErrors
          WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
          StrCpy $launchLink "$newStartMenuLink"
        ${endIf}
        ${ifNot} ${FileExists} "$newDesktopLink"
          CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
          ClearErrors
          WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
        ${endIf}
        System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
      ${endIf}
    ${endIf}
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" ShortcutsRestored "true"
  !macroend

  !macro customFinishPage
    ; electron-builder's own finish page (assistedInstaller.nsh), with the 开机时启动 box added.
    Function StartApp
      Call spicaFinishApply
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW spicaFinishShow
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE spicaFinishApply
    !insertmacro MUI_PAGE_FINISH

    ; After the page: it declares $mui.FinishPage and $mui.FinishPage.Run.
    Function spicaFinishShow
      ; Where 「运行」 is, in the page's pixels: $2 left, $3 top, $4 width, $5 height.
      System::Call '*(i, i, i, i) p .r1'
      System::Call 'user32::GetWindowRect(p $mui.FinishPage.Run, p r1)'
      System::Call 'user32::MapWindowPoints(p 0, p $mui.FinishPage, p r1, i 2)'
      System::Call '*$1(i .r2, i .r3, i .r4, i .r5)'
      System::Free $1
      IntOp $4 $4 - $2
      IntOp $5 $5 - $3
      ; One and a half rows down, the same left edge, width and height.
      IntOp $3 $3 + $5
      IntOp $6 $5 / 2
      IntOp $3 $3 + $6
      ${NSD_CreateCheckbox} $2 $3 $4 $5 "开机时启动"
      Pop $spicaAutostartBox
      SetCtlColors $spicaAutostartBox "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
      ReadRegStr $1 HKCU "${SPICA_RUN_KEY}" "${APP_ID}"
      ${if} $1 != ""
        ${NSD_Check} $spicaAutostartBox
      ${endIf}
    FunctionEnd

    ; 完成: what the box says. Runs before the app starts, so it reads its sign-in entry as left here.
    Function spicaFinishApply
      ${if} $spicaApplied == "1"
        Return
      ${endIf}
      StrCpy $spicaApplied "1"

      ${NSD_GetState} $spicaAutostartBox $0
      ${if} $0 == ${BST_CHECKED}
        WriteRegStr HKCU "${SPICA_RUN_KEY}" "${APP_ID}" '"$appExe" --autostart'
      ${else}
        DeleteRegValue HKCU "${SPICA_RUN_KEY}" "${APP_ID}"
      ${endIf}
    FunctionEnd
  !macroend
!endif

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "${SPICA_RUN_KEY}" "${APP_ID}"
    ; Task Manager's on / off for that entry.
    DeleteRegValue HKCU "${SPICA_STARTUP_APPROVED}" "${APP_ID}"
  ${endIf}
!macroend
