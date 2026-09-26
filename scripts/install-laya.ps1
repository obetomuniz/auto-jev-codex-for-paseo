[CmdletBinding()]
param(
  [ValidateSet("cpu", "cuda", "auto")]
  [string]$Device = "auto",
  [ValidateSet("english", "multilingual", "typed-decisions")]
  [string]$Model = "multilingual",
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$LayaVersion = "0.3.5"
$PythonVersion = "3.12.10"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot ".laya-python"
$venvRoot = Join-Path $projectRoot ".venv-laya"
$cacheRoot = Join-Path $projectRoot ".laya-cache"
$venvPython = Join-Path $venvRoot "Scripts\python.exe"
$runtimePython = Join-Path $runtimeRoot "python.exe"

function Test-CompatiblePython([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $false }
  $version = & $Path -I -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
  return $LASTEXITCODE -eq 0 -and $version -match "^3\.(10|11|12|13)$"
}

function Find-InstalledPython {
  foreach ($candidate in @($runtimePython, $Python)) {
    if ($candidate -and (Test-CompatiblePython $candidate)) { return $candidate }
  }
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($line in (& py -0p 2>$null)) {
      if ($line -match '([A-Za-z]:\\.*python\.exe)\s*$') {
        $candidate = $Matches[1]
        if (Test-CompatiblePython $candidate) { return $candidate }
      }
    }
  }
  return $null
}

function Install-PluginPython {
  $installer = Join-Path $env:TEMP "python-$PythonVersion-amd64.exe"
  $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"
  Write-Host "Downloading Python $PythonVersion for the local Laya environment..."
  Invoke-WebRequest -Uri $url -OutFile $installer
  try {
    $arguments = @("/quiet", "InstallAllUsers=0", "TargetDir=$runtimeRoot", "PrependPath=0", "Include_doc=0", "Include_test=0", "Include_launcher=0")
    $process = Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Python installer exited with code $($process.ExitCode)." }
  } finally {
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
  }
  if (!(Test-CompatiblePython $runtimePython)) { throw "The local Python installation is not compatible with Laya." }
  return $runtimePython
}

$basePython = Find-InstalledPython
if (!$basePython) { $basePython = Install-PluginPython }
if (!(Test-Path -LiteralPath $venvPython)) {
  Write-Host "Creating the isolated Laya environment..."
  & $basePython -m venv $venvRoot
  if ($LASTEXITCODE -ne 0) { throw "Could not create the Laya virtual environment." }
}

Write-Host "Installing Laya $LayaVersion and its dependencies..."
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Could not upgrade pip in the Laya environment." }
$cudaTorch = Get-ChildItem -LiteralPath (Join-Path $venvRoot "Lib\site-packages") -Filter "torch-*+cu130.dist-info" -ErrorAction SilentlyContinue
if ($Device -eq "cuda" -and !$cudaTorch) {
  & $venvPython -m pip install --upgrade --force-reinstall torch --index-url https://download.pytorch.org/whl/cu130
  if ($LASTEXITCODE -ne 0) { throw "Could not install the CUDA build of PyTorch." }
}
& $venvPython -m pip install "laya==$LayaVersion"
if ($LASTEXITCODE -ne 0) { throw "Could not install Laya $LayaVersion." }

$subfolder = if ($Model -eq "english") { "None" } else { "'$Model'" }
$loadCode = @"
import laya
import torch
assert laya.__version__ == '$LayaVersion', laya.__version__
agent = laya.load('convaiinnovations/laya', subfolder=$subfolder, device=None if '$Device' == 'auto' else '$Device')
if '$Device' != 'auto' and agent.device.type != '$Device':
    raise RuntimeError(f'requested $Device but loaded {agent.device.type}')
print(f'Laya {laya.__version__} ready on {agent.device.type}; CUDA available: {torch.cuda.is_available()}')
"@
$env:HF_HOME = $cacheRoot
$env:HF_HUB_DISABLE_SYMLINKS = "1"
Write-Host "Preloading the $Model Laya model..."
& $venvPython -I -c $loadCode
if ($LASTEXITCODE -ne 0) { throw "Laya installed but could not load the selected model on $Device." }

$settingsRoot = Join-Path $env:USERPROFILE ".paseo"
$settingsPath = Join-Path $settingsRoot "auto-mode-for-paseo.local.json"
$settings = [ordered]@{}
if (Test-Path -LiteralPath $settingsPath) {
  $existing = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
  foreach ($property in $existing.PSObject.Properties) { $settings[$property.Name] = $property.Value }
}
$settings["classifier"] = "laya"
$settings["layaPython"] = $venvPython
$settings["layaCache"] = $cacheRoot
$settings["layaModel"] = $Model
$settings["layaDevice"] = $Device
New-Item -ItemType Directory -Force -Path $settingsRoot | Out-Null
$json = ($settings | ConvertTo-Json -Depth 10) + [Environment]::NewLine
[System.IO.File]::WriteAllText($settingsPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Laya is ready. Paseo will use $Model on $Device with $venvPython."