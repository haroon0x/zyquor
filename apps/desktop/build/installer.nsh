!macro customInstall
  CreateShortCut "$DESKTOP\Zyquor.lnk" "$INSTDIR\Zyquor.exe" "" "$INSTDIR\resources\icon.ico" 0
  CreateShortCut "$SMPROGRAMS\Zyquor.lnk" "$INSTDIR\Zyquor.exe" "" "$INSTDIR\resources\icon.ico" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Zyquor.lnk"
  Delete "$SMPROGRAMS\Zyquor.lnk"
!macroend
