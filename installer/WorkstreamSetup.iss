#define MyAppName "Workstream"
#define MyAppVersion "0.2.7"
#define MyAppPublisher "Workstream"
#ifndef AgentPublishDir
  #define AgentPublishDir "..\\apps\\employee-agent\\bin\\Release\\net8.0-windows\\win-x64\\publish"
#endif
[Setup]
AppId={{5C76E57E-058A-4DCB-ADDB-51B363A4CF7C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Workstream
DefaultGroupName=Workstream
OutputBaseFilename=WorkstreamSetup
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
[Files]
Source: "{#AgentPublishDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
[Icons]
Name: "{autostartup}\Workstream"; Filename: "{app}\Workstream.exe"
Name: "{autoprograms}\Workstream"; Filename: "{app}\Workstream.exe"
[Run]
Filename: "{app}\Workstream.exe"; Description: "Launch Workstream"; Flags: nowait postinstall skipifsilent
[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM Workstream.exe"; Flags: runhidden waituntilterminated
[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\Workstream"
[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    DelTree(ExpandConstant('{localappdata}\Workstream'), True, True, True);
end;
