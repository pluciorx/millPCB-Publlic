# Download KiCad footprint libraries
$base = "https://raw.githubusercontent.com/KiCad/kicad-footprints/master"
$dest = "c:\Git\qwenTest\libs"
$ok = 0; $fail = 0

function Download($lib, $file, $cat) {
    $url = "$base/$lib/$file"
    $outPath = "$dest/$cat/$file"
    try {
        curl.exe -sL -o $outPath $url
        if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }
        # Check it's not a 404 page
        $content = Get-Content $outPath -Raw -ErrorAction Stop
        if ($content -match "404: Not Found") { Remove-Item $outPath; throw "404" }
        Write-Host "  OK: $cat/$file"
        $script:ok++
    } catch {
        Write-Host "  FAIL: $cat/$file ($($_.Exception.Message))"
        $script:fail++
    }
}

Write-Host "`n=== RESISTORS ==="
Download "Resistor_SMD.pretty" "R_0402_1005Metric.kicad_mod" "resistors"
Download "Resistor_SMD.pretty" "R_0603_1608Metric.kicad_mod" "resistors"
Download "Resistor_SMD.pretty" "R_0805_2012Metric.kicad_mod" "resistors"
Download "Resistor_SMD.pretty" "R_1206_3216Metric.kicad_mod" "resistors"
Download "Resistor_SMD.pretty" "R_1210_3225Metric.kicad_mod" "resistors"
Download "Resistor_THT.pretty" "R_Axial_DIN0204_L3.6mm_D1.6mm_P5.08mm_Horizontal.kicad_mod" "resistors"

Write-Host "`n=== CAPACITORS ==="
Download "Capacitor_SMD.pretty" "C_0402_1005Metric.kicad_mod" "capacitors"
Download "Capacitor_SMD.pretty" "C_0603_1608Metric.kicad_mod" "capacitors"
Download "Capacitor_SMD.pretty" "C_0805_2012Metric.kicad_mod" "capacitors"
Download "Capacitor_SMD.pretty" "C_1206_3216Metric.kicad_mod" "capacitors"
Download "Capacitor_THT.pretty" "CP_Radial_D5.0mm_P2.50mm.kicad_mod" "capacitors"
Download "Capacitor_THT.pretty" "CP_Radial_D8.0mm_P3.50mm.kicad_mod" "capacitors"

Write-Host "`n=== LEDs ==="
Download "LED_SMD.pretty" "LED_0603_1608Metric.kicad_mod" "leds"
Download "LED_SMD.pretty" "LED_0805_2012Metric.kicad_mod" "leds"
Download "LED_SMD.pretty" "LED_1206_3216Metric.kicad_mod" "leds"
Download "LED_THT.pretty" "LED_D3.0mm.kicad_mod" "leds"
Download "LED_THT.pretty" "LED_D5.0mm.kicad_mod" "leds"

Write-Host "`n=== INDUCTORS ==="
Download "Inductor_SMD.pretty" "L_0402_1005Metric.kicad_mod" "inductors"
Download "Inductor_SMD.pretty" "L_0603_1608Metric.kicad_mod" "inductors"
Download "Inductor_SMD.pretty" "L_0805_2012Metric.kicad_mod" "inductors"
Download "Inductor_SMD.pretty" "L_1206_3216Metric.kicad_mod" "inductors"

Write-Host "`n=== DIODES ==="
Download "Diode_SMD.pretty" "D_SOD-323.kicad_mod" "diodes"
Download "Diode_SMD.pretty" "D_SOD-123.kicad_mod" "diodes"
Download "Diode_SMD.pretty" "D_SMA.kicad_mod" "diodes"
Download "Diode_SMD.pretty" "D_SMB.kicad_mod" "diodes"
Download "Diode_THT.pretty" "D_DO-41.kicad_mod" "diodes"

Write-Host "`n=== ICs (SO/DIP) ==="
Download "Package_SO.pretty" "SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod" "ics"
Download "Package_SO.pretty" "SOIC-16_7.5x10.3mm_P1.27mm.kicad_mod" "ics"
Download "Package_DIP.pretty" "DIP-8_W7.62mm.kicad_mod" "ics"
Download "Package_DIP.pretty" "DIP-14_W7.62mm.kicad_mod" "ics"

Write-Host "`n=== TRANSISTORS ==="
Download "Package_TO_SOT_SMD.pretty" "SOT-23.kicad_mod" "transistors"
Download "Package_TO_SOT_SMD.pretty" "SOT-89-3.kicad_mod" "transistors"
Download "Package_TO_SOT_SMD.pretty" "TO-252-2.kicad_mod" "transistors"
Download "Package_TO_SOT_THT.pretty" "TO-92_Inline_PinSpan2.54mm.kicad_mod" "transistors"
Download "Package_TO_SOT_THT.pretty" "TO-220-3_Horizontal_TabDown.kicad_mod" "transistors"

Write-Host "`n=== CONNECTORS ==="
Download "Connector_PinHeader_2.54mm.pretty" "PinHeader_2.54mm_PTH_2x03_Vertical.kicad_mod" "connectors"
Download "Connector_PinHeader_2.54mm.pretty" "PinHeader_2.54mm_PTH_2x04_Vertical.kicad_mod" "connectors"
Download "Connector_PinHeader_2.54mm.pretty" "PinHeader_2.54mm_PTH_2x05_Vertical.kicad_mod" "connectors"
Download "Connector_USB.pretty" "USB_C_Receptacle_GCT_USB4105.kicad_mod" "connectors"

Write-Host "`n=== MISC ==="
Download "Crystal.pretty" "ABM3S_3.8x3.8mm_P2.50mm_Horizontal.kicad_mod" "misc"
Download "MountingHole.pretty" "MountingHole_3.2mm_M3.kicad_mod" "misc"
Download "Fuse.pretty" "Fuseholder_BladeFuse_Horizontal.kicad_mod" "misc"
Download "Potentiometer_THT.pretty" "Potentiometer_THT_SingleTurn_L8.50mm_W6.10mm_P7.62mm.kicad_mod" "misc"

Write-Host "`n=== SUMMARY: $ok OK, $fail FAILED ==="
