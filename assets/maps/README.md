# Maps

Tiled map files (.tmx) for the village.

## Tools

- [Tiled Map Editor](https://www.mapeditor.org/) (free, open source)
- Export as `.tmx` (XML format)

## Map layers

1. **Ground** — Grass, paths, water
2. **Buildings** — Houses, shops, cafés (collision layer)
3. **Objects** — Trees, benches, lamps, signs
4. **Collision** — Invisible layer marking impassable tiles
5. **Zones** — Named areas for agent navigation (home, café, park, etc.)

## Naming convention

- `village_v1.tmx` — Main village map
- `village_v1_collision.json` — Exported collision data
- `village_v1_zones.json` — Exported zone data
