$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$publish = Join-Path $root 'artifacts\agent-publish'
$output = Join-Path $root 'artifacts\installer'
New-Item -ItemType Directory -Force -Path $publish,$output | Out-Null

$agentProject = Join-Path $root 'apps\employee-agent\Workstream.Agent.csproj'
[xml]$agentProjectXml = Get-Content -LiteralPath $agentProject
$agentVersion = [string]($agentProjectXml.Project.PropertyGroup.Version | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($agentVersion)) { throw 'The Windows agent project does not define a Version.' }
dotnet restore $agentProject --runtime win-x64 --ignore-failed-sources
if ($LASTEXITCODE -ne 0) { throw 'The Windows agent restore failed. Install/enable the .NET 8 win-x64 runtime packs or provide NuGet access.' }
dotnet publish $agentProject --configuration Release --runtime win-x64 --self-contained true `
  -p:PublishSingleFile=false -p:PublishTrimmed=false -o $publish --no-restore
if ($LASTEXITCODE -ne 0) { throw 'The Windows agent publish failed.' }

$isccCandidates = @(
  (Join-Path ${env:ProgramFiles} 'Inno Setup 6\ISCC.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
  (Join-Path ${env:LOCALAPPDATA} 'Programs\Inno Setup 6\ISCC.exe')
)
$iscc = $isccCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 (ISCC.exe) is required to create the real WorkstreamSetup.exe.' }

& $iscc (Join-Path $PSScriptRoot 'WorkstreamSetup.iss') "/DMyAppVersion=$agentVersion" "/DAgentPublishDir=$publish" "/O$output"
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed to compile WorkstreamSetup.exe.' }
$installer = Join-Path $output 'WorkstreamSetup.exe'
if (-not (Test-Path -LiteralPath $installer)) { throw "Installer build did not produce $installer" }
Write-Output "CURRENT WORKSTREAM INSTALLER: $installer"
