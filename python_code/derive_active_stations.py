import json
from pathlib import Path
from typing import List, Dict


def derive_active_stations() -> Path:
    repo_root = Path(__file__).resolve().parent.parent
    in_path = repo_root / 'data' / 'reference' / 'volcano_station_availability.json'
    out_path = repo_root / 'data' / 'reference' / 'active_volcano_stations.json'

    if not in_path.exists():
        raise FileNotFoundError(f"Input not found: {in_path}")

    with open(in_path, 'r') as f:
        results: List[Dict] = json.load(f)

    active: List[Dict] = []
    for r in results:
        name = r.get('name')
        vnum = r.get('vnum')
        lat = r.get('lat')
        lon = r.get('lon')

        for ch in r.get('seismic_channels', []):
            if not ch.get('end_time'):
                active.append({'type': 'seismic', 'volcano': name, 'vnum': vnum, 'volcano_lat': lat, 'volcano_lon': lon, **ch})
        for ch in r.get('infrasound_channels', []):
            if not ch.get('end_time'):
                active.append({'type': 'infrasound', 'volcano': name, 'vnum': vnum, 'volcano_lat': lat, 'volcano_lon': lon, **ch})

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(active, f, indent=2)

    return out_path


if __name__ == '__main__':
    out = derive_active_stations()
    print(f"Wrote {out}")
