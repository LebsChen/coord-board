# Coord Board Office scene source

This directory is the canonical, framework-neutral Office scene source.

It contains Pixi scene code, Agent types, navigation, visit simulation, layout,
animation/depth systems, labels, and the pure Office feed adapter. It must not
import React, Tauri APIs, or a host-specific scene bridge.

Cloud-Dev consumes a generated vendor copy under its `src/office/` tree.
Re-sync that copy when this directory changes and update its manifest. The
Cloud-Dev vendor check verifies that its committed files still match the
recorded source manifest.
