; The installer's last page (included by electron-builder: electron-builder.yml nsis.include).
; Under 「运行 <name>」 three boxes: 开机时启动, 创建桌面快捷方式, 创建开始菜单快捷方式.
;
; - A first install does all three (electron-builder makes both shortcuts; the sign-in entry is written here),
;   so the boxes start ticked and leaving the page any way keeps them. Unticking one and pressing 完成 undoes it.
; - Installing again over an installed copy: each box starts as things are now (a shortcut the user deleted, or
;   autostart turned off in 设置, stays off unless ticked here). electron-builder keeps deleted shortcuts deleted
;   on its own (KeepShortcuts); the sign-in entry is only written on a first install.
; - An update (the app runs the installer with --updated /S) shows no page and changes none of the three.
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
  Var spicaApplied
  Var spicaAutostartBox
  Var spicaDesktopBox
  Var spicaMenuBox

  !macro customInit
    ; An installed copy already here (this user): then the boxes show how things are, nothing is added.
    ReadRegStr $spicaHadInstall HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  !macroend

  !macro customInstall
    ${ifNot} ${isUpdated}
    ${andIf} $spicaHadInstall == ""
      WriteRegStr HKCU "${SPICA_RUN_KEY}" "${APP_ID}" '"$appExe" --autostart'
    ${endIf}
  !macroend

  ; A box under the one before: the same left edge, width and height, one and a half rows down.
  !macro spicaBox VAR TEXT ON
    IntOp $3 $3 + $6
    IntOp $3 $3 + $7
    ${NSD_CreateCheckbox} $2 $3 $4 $5 "${TEXT}"
    Pop ${VAR}
    SetCtlColors ${VAR} "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    ${if} ${ON} == 1
      ${NSD_Check} ${VAR}
    ${endIf}
  !macroend

  !macro customFinishPage
    ; electron-builder's own finish page (assistedInstaller.nsh), with the three boxes added.
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
      StrCpy $6 $5
      IntOp $7 $5 / 2

      StrCpy $0 0
      ReadRegStr $1 HKCU "${SPICA_RUN_KEY}" "${APP_ID}"
      ${if} $1 != ""
        StrCpy $0 1
      ${endIf}
      !insertmacro spicaBox $spicaAutostartBox "开机时启动" $0

      StrCpy $0 0
      ${if} ${FileExists} "$newDesktopLink"
        StrCpy $0 1
      ${endIf}
      !insertmacro spicaBox $spicaDesktopBox "创建桌面快捷方式" $0

      StrCpy $0 0
      ${if} ${FileExists} "$newStartMenuLink"
        StrCpy $0 1
      ${endIf}
      !insertmacro spicaBox $spicaMenuBox "创建开始菜单快捷方式" $0
    FunctionEnd

    ; 完成: what the boxes say. Runs before the app starts, so it reads its sign-in entry as left here.
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

      ${NSD_GetState} $spicaDesktopBox $0
      ${if} $0 == ${BST_CHECKED}
        ${ifNot} ${FileExists} "$newDesktopLink"
          CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
          ClearErrors
          WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
        ${endIf}
      ${else}
        WinShell::UninstShortcut "$newDesktopLink"
        Delete "$newDesktopLink"
      ${endIf}

      ${NSD_GetState} $spicaMenuBox $0
      ${if} $0 == ${BST_CHECKED}
        ${ifNot} ${FileExists} "$newStartMenuLink"
          CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
          ClearErrors
          WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
        ${endIf}
      ${else}
        WinShell::UninstShortcut "$newStartMenuLink"
        Delete "$newStartMenuLink"
      ${endIf}
      ; 运行 starts the app through the Start menu shortcut when there is one.
      ${ifNot} ${FileExists} "$launchLink"
        StrCpy $launchLink "$appExe"
      ${endIf}

      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
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
