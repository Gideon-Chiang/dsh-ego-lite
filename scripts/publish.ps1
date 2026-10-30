# Publish dsh-ego-lite to npm with an automation token.
# Usage:  $env:NPM_TOKEN = "npm_xxx"; .\scripts\publish.ps1 [-Tag latest]
param(
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:NPM_TOKEN) {
    throw "NPM_TOKEN is empty. Create a token at https://www.npmjs.com/settings/~/tokens and set `$env:NPM_TOKEN."
}

$npmrc = Join-Path $root ".npmrc.publish"
$createdNpmrc = $false
try {
    if (-not (Test-Path $npmrc)) {
        "//registry.npmjs.org/:_authToken=`${NPM_TOKEN}" | Set-Content $npmrc -Encoding ascii
        $createdNpmrc = $true
    }
    npm publish --userconfig $npmrc --tag $Tag
    if ($LASTEXITCODE -ne 0) { throw "npm publish failed with exit code $LASTEXITCODE" }
    $name = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).name
    $version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
    Write-Host "published $name@$version; check: npm view $name version"
}
finally {
    if ($createdNpmrc -and (Test-Path $npmrc)) { Remove-Item $npmrc -Force }
}
