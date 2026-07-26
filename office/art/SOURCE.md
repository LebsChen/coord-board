# Office art provenance

The files in this directory are original artwork supplied for the Coord Board
Office by the project owner. They were generated for this project and are
owned by the project; no code, sprites, or other assets were copied from
third-party office visualizations.

The committed WebP files are optimized derivatives of the supplied PNG
sources. The desk, chair, room, amenity, and character magenta backgrounds
were keyed to real alpha with edge de-fringing during conversion. The scene
uses one coherent all-white minimalist render style, with a separately drawn
chair, figure, desk, monitor, and front-facing room pieces. The figure sheet
is shared by every agent, including the lead.

The keyed-asset sanity check in `scripts/check-office-art.py` verifies that
real transparency exists and that surviving light source pixels remain neutral
white/grey rather than being channel-mixed by the magenta key.
