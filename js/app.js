// ============================================================
// PCB Editor - Bootstrap
// All logic lives in modular files loaded before this script.
// This file simply initializes the app after DOM is ready.
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    if (typeof LibsLoader !== 'undefined' && LibsLoader.applyEmbed) LibsLoader.applyEmbed();
    App.init();
    // The component palette can be dragged out of the left panel; double-click
    // its heading to snap it back.
    const palette = document.getElementById('component-palette');
    const paletteBlock = palette && palette.closest ? palette.closest('.panel-section') : null;
    if (paletteBlock) App.makeDraggable(paletteBlock, paletteBlock.querySelector('h3') || paletteBlock, 'palette');
    if (typeof Model3D !== 'undefined') { Model3D.bind('model3d-canvas'); Model3D.bind('board3d-canvas'); }
    if (typeof KicadImport !== 'undefined') KicadImport.init();
    if (typeof ComponentLibrary !== 'undefined') ComponentLibrary.init();
    if (typeof LibsLoader !== 'undefined') {
        // Refresh from /libs/ when fetch works (HTTP). Embed already applied above
        // so file:// and the first paint use KiCad geometry, not cartoon boards.
        if (!/^(file:|chrome-extension:)/i.test(location.protocol)) {
            LibsLoader.load().catch(e => console.warn('[LibsLoader]', e));
        }
    }
});
