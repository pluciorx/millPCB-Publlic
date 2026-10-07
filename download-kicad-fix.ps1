# Fix failed downloads with correct filenames
$base = "https://raw.githubusercontent.com/KiCad/kicad-footprints/master"
$dest = "c:\Git\qwenTest\libs"
$ok = 0; $fail = 0

function Download($lib, $file, $cat) {
    $url = "$base/$lib/$file"
    $outPath = "$dest/$cat/$file"
    try {
        curl.exe -sL -o $outPath $url
        if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }
        $content = Get-Content $outPath -Raw -ErrorAction Stop
        if ($content -match "404: Not Found") { Remove-Item $outPath; throw "404" }
        Write-Host "  OK: $cat/$file"
        $script:ok++
    } catch {
        Write-Host "  FAIL: $cat/$file ($($_.Exception.Message))"
        $script:fail++
    }
}

Write-Host "`n=== FIXES ==="

# DO-41 diode - correct name includes SOD81 and pitch
Download "Diode_THT.pretty" "D_DO-41_SOD81_P7.62mm_Horizontal.kicad_mod" "diodes"

# SOIC-16 - try narrow body variant  
Download "Package_SO.pretty" "SOIC-16_3.9x9.9mm_P1.27mm.kicad_mod" "ics"
# If that fails, try wide
if (-not (Test-Path "$dest/ics/SOIC-16_3.9x9.9mm_P1.27mm.kicad_mod")) {
    Download "Package_SO.pretty" "SOIC-16_7.5x10.3mm_P1.27mm.kicad_mod" "ics"
}

# TO-92 - try different naming conventions
Download "Package_TO_SOT_THT.pretty" "TO-92_Inline_PinSpan2.54mm.kicad_mod" "transistors"
if (-not (Test-Path "$dest/transistors/TO-92_Inline_PinSpan2.54mm.kicad_mod")) {
    Download "Package_TO_SOT_THT.pretty" "TO-92.kicad_mod" "transistors"
}

# Pin headers - correct naming is PinHeader_{rows}x{cols}_P{pitch}mm_{orient}
Download "Connector_PinHeader_2.54mm.pretty" "PinHeader_2x03_P2.54mm_Vertical.kicad_mod" "connectors"
Download "Connector_PinHeader_2.54mm.pretty" "PinHeader_2x04_P2.54mm_Vertical.kicad_mod" "connectors"
Download "Connector_PinHeader_2.54mm.pretty" "PinHeader_2x05_P2.54mm_Vertical.kicad_mod" "connectors"

# USB-C receptacle - use GCT USB4085 (common one)
Download "Connector_USB.pretty" "USB_C_Receptacle_GCT_USB4085.kicad_mod" "connectors"

# Crystal - SMD ABM3 is very common
Download "Crystal.pretty" "Crystal_SMD_Abracon_ABM3-2Pin_5.0x3.2mm.kicad_mod" "misc"

# Fuse - try a common blade fuse holder
Download "Fuse.pretty" "Fuseholder_Bussmann_FRS-Horizontal.kicad_mod" "misc"

# Potentiometer - try standard THT pot
Download "Potentiometer_THT.pretty" "Potentiometer_THT_SingleTurn_L6.50mm_W4.30mm_P5.08mm.kicad_mod" "misc"

Write-Host "`n=== FIX SUMMARY: $ok OK, $fail FAILED ==="
