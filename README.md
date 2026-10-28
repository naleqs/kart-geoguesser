# Kart GeoGuesser

Drive a kart through 360° street imagery, then guess where in the world you are.

- Runs entirely in the browser. The kart, driver and textures are decoded on the fly from **your own Mario Kart DS ROM** (`.nds`), which you pick when the page opens. The ROM stays in your browser and is never uploaded. No game files are included in this repository.
- Every round starts in a capital city. Music is played from the ROM's own sound archive.
- Street imagery comes from [Panoramax](https://panoramax.fr) (open data); maps are Esri World Street Map (English labels).

**Controls:** W/↑ drive · S/↓ brake/reverse · A/D steer · Space hop · drag to look · M map · N mute (or the 🔊 button) · ⏭ next song

**Run locally:** put the ROM folder next to `index.html` and run `start.bat` (Windows), or serve the folder with any static web server.
