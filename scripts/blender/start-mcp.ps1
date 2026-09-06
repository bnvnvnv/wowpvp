param(
    [string]$BlenderPath = 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe',
    [string]$ToolEnvironment = 'E:\work\tools\blendmcp-env',
    [int]$Port = 9877
)

$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$bootstrapPath = Join-Path $PSScriptRoot 'bootstrap_mcp.py'
$logDirectory = Join-Path $workspacePath 'scripts\.diag\blender-mcp'
if (-not (Test-Path -LiteralPath $BlenderPath)) { throw 'Blender executable was not found' }
if (-not (Test-Path -LiteralPath (Join-Path $ToolEnvironment 'Scripts\blendmcp.exe'))) { throw 'BlendMCP environment was not found' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Output "Port $Port is already in use. Reuse the running Blender instance or choose another port."
    exit 1
}
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$env:BLENDER_PORT = [string]$Port
$env:WOWPVP_BLENDER_MCP_ENV = $ToolEnvironment
Start-Process -FilePath $BlenderPath -ArgumentList @('--factory-startup', '--python', ('"' + $bootstrapPath + '"')) `
    -WorkingDirectory $workspacePath -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDirectory 'blender.log') `
    -RedirectStandardError (Join-Path $logDirectory 'blender-error.log') -PassThru |
    Select-Object Id
