# Registra o native host para o usuário atual (Chrome e Edge).
$manifest = Join-Path $PSScriptRoot 'com.alex.m3d_blender.json'
foreach ($root in 'HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts') {
    $key = Join-Path $root 'com.alex.m3d_blender'
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $manifest
    Write-Host "registrado: $key -> $manifest"
}
