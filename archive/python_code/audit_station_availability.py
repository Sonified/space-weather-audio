import json
import time
import csv
import argparse
from typing import List, Dict, Optional, Tuple
from pathlib import Path

import requests

try:
    import pandas as pd  # Optional; script works without pandas
except Exception:  # pragma: no cover
    pd = None  # type: ignore

def _import_filter_helper():
    """Import filter_actual_volcanoes whether run as module or script."""
    try:
        # When running as a module with repo root on sys.path
        from python_code.data_management import filter_actual_volcanoes  # type: ignore
        return filter_actual_volcanoes
    except Exception:
        # Fallback: add repo root to path based on this file location
        import sys
        repo_root = Path(__file__).resolve().parent.parent
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))
        from python_code.data_management import filter_actual_volcanoes  # type: ignore
        return filter_actual_volcanoes

filter_actual_volcanoes = _import_filter_helper()


def load_monitored_volcanoes(repo_root: Path) -> List[Dict]:
    """Load monitored volcanoes JSON from repo, filter to entries with vnum."""
    candidates = [
        repo_root / 'data' / 'reference' / 'monitored_volcanoes.json',
        repo_root / 'reference' / 'monitored_volcanoes.json',
    ]
    for path in candidates:
        if path.exists():
            with open(path, 'r') as f:
                data = json.load(f)
            return filter_actual_volcanoes(data)
    print("Error: monitored_volcanoes.json not found in expected locations.")
    return []


def get_volcano_coords(vnum: str, timeout_seconds: int = 10) -> Tuple[Optional[float], Optional[float]]:
    """Get lat/lon from USGS using Smithsonian volcano number."""
    url = f"https://volcanoes.usgs.gov/hans-public/api/volcano/getVolcano/{vnum}"
    try:
        response = requests.get(url, timeout=timeout_seconds)
        if response.status_code != 200:
            return None, None
        data = response.json()
        # Response can be a dict or list; normalize
        if isinstance(data, list) and data:
            data = data[0]
        if not isinstance(data, dict):
            return None, None
        lat = data.get('latitude')
        lon = data.get('longitude')
        try:
            return (float(lat) if lat is not None else None,
                    float(lon) if lon is not None else None)
        except Exception:
            return None, None
    except Exception:
        return None, None


def query_iris_stations(lat: float, lon: float, radius_km: float = 50.0, timeout_seconds: int = 15, networks: Optional[str] = None) -> Optional[str]:
    """Query IRIS FDSN Station service for channels near a location."""
    if lat is None or lon is None:
        return None
    url = "https://service.iris.edu/fdsnws/station/1/query"
    params = {
        'latitude': lat,
        'longitude': lon,
        'maxradius': radius_km / 111.0,  # approx deg per km
        'level': 'channel',
        'format': 'text',
        'nodata': '404',
    }
    # If networks are specified, include them; otherwise query all networks
    if networks:
        params['network'] = networks
    try:
        response = requests.get(url, params=params, timeout=timeout_seconds)
        if response.status_code == 200:
            return response.text
        return None
    except Exception:
        return None


def _parse_float(value: str) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def _parse_str(value: str) -> str:
    return value.strip() if value is not None else ""


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/lon points in kilometers."""
    from math import radians, sin, cos, asin, sqrt
    try:
        rlat1, rlon1, rlat2, rlon2 = map(radians, [lat1, lon1, lat2, lon2])
        dlat = rlat2 - rlat1
        dlon = rlon2 - rlon1
        a = sin(dlat/2) ** 2 + cos(rlat1) * cos(rlat2) * sin(dlon/2) ** 2
        c = 2 * asin(sqrt(a))
        earth_radius_km = 6371.0
        return earth_radius_km * c
    except Exception:
        return 0.0


def parse_iris_response(text: Optional[str]) -> Optional[Dict[str, List[Dict]]]:
    """Parse IRIS text response and categorize channels by type."""
    if not text:
        return None
    lines = text.strip().split('\n')
    data_lines = [l for l in lines if l and not l.startswith('#')]

    seismic_channels: List[Dict] = []
    infrasound_channels: List[Dict] = []

    for line in data_lines:
        parts = line.split('|')
        if len(parts) < 8:
            continue
        # IRIS 'level=channel' text typically: Net|Sta|Loc|Cha|Lat|Lon|Ele|Dep|Az|Dip|Inst|Scale|ScaleFreq|ScaleUnits|SampleRate|Start|End
        network = parts[0]
        station = parts[1]
        location = parts[2]
        channel = parts[3]
        lat = _parse_float(parts[4]) if len(parts) > 4 else 0.0
        lon = _parse_float(parts[5]) if len(parts) > 5 else 0.0
        elevation_m = _parse_float(parts[6]) if len(parts) > 6 else 0.0
        depth_m = _parse_float(parts[7]) if len(parts) > 7 else 0.0
        azimuth_deg = _parse_float(parts[8]) if len(parts) > 8 else 0.0
        dip_deg = _parse_float(parts[9]) if len(parts) > 9 else 0.0
        instrument = _parse_str(parts[10]) if len(parts) > 10 else ""
        scale = _parse_float(parts[11]) if len(parts) > 11 else 0.0
        scale_freq_hz = _parse_float(parts[12]) if len(parts) > 12 else 0.0
        scale_units = _parse_str(parts[13]) if len(parts) > 13 else ""
        start_time = _parse_str(parts[15]) if len(parts) > 15 else ""
        end_time = _parse_str(parts[16]) if len(parts) > 16 else ""
        # Try common index for sample rate; fall back if columns vary
        sample_rate = 0.0
        for idx in (14, 8, -1):
            if 0 <= idx < len(parts):
                sr = _parse_float(parts[idx])
                if sr > 0:
                    sample_rate = sr
                    break

        # Seismic channels: HH*, BH*, EH* with Z/N/E components
        if len(channel) >= 3 and channel[:2] in {'HH', 'BH', 'EH'} and channel[2] in {'Z', 'N', 'E'}:
            seismic_channels.append({
                'network': network,
                'station': station,
                'location': location,
                'channel': channel,
                'latitude': lat,
                'longitude': lon,
                'elevation_m': elevation_m,
                'depth_m': depth_m,
                'azimuth_deg': azimuth_deg,
                'dip_deg': dip_deg,
                'instrument': instrument,
                'scale': scale,
                'scale_freq_hz': scale_freq_hz,
                'scale_units': scale_units,
                'start_time': start_time,
                'end_time': end_time,
                'sample_rate': sample_rate,
            })
        # Infrasound channels: DF*, BD*, BDF* (prefix covers DF, BD; allow any 2-char infra starting with D or BD)
        elif channel.startswith('DF') or channel.startswith('BD'):
            infrasound_channels.append({
                'network': network,
                'station': station,
                'location': location,
                'channel': channel,
                'latitude': lat,
                'longitude': lon,
                'elevation_m': elevation_m,
                'depth_m': depth_m,
                'azimuth_deg': azimuth_deg,
                'dip_deg': dip_deg,
                'instrument': instrument,
                'scale': scale,
                'scale_freq_hz': scale_freq_hz,
                'scale_units': scale_units,
                'start_time': start_time,
                'end_time': end_time,
                'sample_rate': sample_rate,
            })

    return {'seismic': seismic_channels, 'infrasound': infrasound_channels}


def summarize_availability(channels: List[Dict]) -> Tuple[str, List[float]]:
    if not channels:
        return "None", []
    stations = sorted({c['station'] for c in channels})
    sample_rates = sorted({c.get('sample_rate', 0.0) for c in channels}, reverse=True)
    return f"{len(stations)} stations", list(sample_rates)


def write_outputs(repo_root: Path, results: List[Dict]) -> Tuple[Path, Path]:
    out_dir = repo_root / 'data' / 'reference'
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / 'volcano_station_availability.json'
    csv_path = out_dir / 'volcano_station_summary.csv'

    with open(json_path, 'w') as f:
        json.dump(results, f, indent=2)

    # CSV via pandas if available, else csv module
    rows = [{
        'Volcano': r['name'],
        'Seismic': '✓' if r['seismic_available'] else '✗',
        'Infrasound': '✓' if r['infrasound_available'] else '✗',
        'Seismic Hz': ', '.join(map(str, r['seismic_sample_rates'])) if r['seismic_sample_rates'] else '-',
        'Infrasound Hz': ', '.join(map(str, r['infrasound_sample_rates'])) if r['infrasound_sample_rates'] else '-',
    } for r in results]

    if pd is not None:
        df = pd.DataFrame(rows)
        df.to_csv(csv_path, index=False)
    else:
        with open(csv_path, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ['Volcano','Seismic','Infrasound','Seismic Hz','Infrasound Hz'])
            writer.writeheader()
            writer.writerows(rows)

    return json_path, csv_path


def audit_volcanoes(limit: Optional[int] = None, radius_km: float = 50.0, save_every: int = 10) -> List[Dict]:
    repo_root = Path(__file__).resolve().parent.parent
    volcanoes = load_monitored_volcanoes(repo_root)
    if limit is not None:
        volcanoes = volcanoes[:limit]

    total = len(volcanoes)
    print(f"Processing {total} volcanoes...")
    print('-' * 80)

    results: List[Dict] = []
    out_dir = repo_root / 'data' / 'reference'
    out_dir.mkdir(parents=True, exist_ok=True)
    progress_json = out_dir / 'volcano_station_availability.json'

    for index, volcano in enumerate(volcanoes, start=1):
        name = volcano.get('volcano_name')
        vnum = volcano.get('vnum')
        print(f"\n[{index}/{total}] {name} ({vnum})")

        lat, lon = get_volcano_coords(vnum)
        if lat is None or lon is None:
            print("  ⚠️  Could not get coordinates")
            results.append({
                'name': name, 'vnum': vnum, 'lat': None, 'lon': None,
                'seismic_available': False, 'infrasound_available': False,
                'seismic_stations': 0, 'infrasound_stations': 0,
                'seismic_sample_rates': [], 'infrasound_sample_rates': []
            })
            continue

        print(f"  📍 Location: {lat:.3f}, {lon:.3f}")
        iris_text = query_iris_stations(lat, lon, radius_km=radius_km)
        parsed = parse_iris_response(iris_text)

        if parsed is not None:
            seismic_summary, seismic_rates = summarize_availability(parsed['seismic'])
            infrasound_summary, infrasound_rates = summarize_availability(parsed['infrasound'])
            print(f"  🌊 Seismic: {seismic_summary} @ {seismic_rates} Hz")
            print(f"  🔊 Infrasound: {infrasound_summary} @ {infrasound_rates} Hz")
            # Compute distances for each channel
            for ch in parsed['seismic']:
                ch['distance_km'] = haversine_km(lat, lon, ch.get('latitude', 0.0), ch.get('longitude', 0.0))
            for ch in parsed['infrasound']:
                ch['distance_km'] = haversine_km(lat, lon, ch.get('latitude', 0.0), ch.get('longitude', 0.0))

            results.append({
                'name': name, 'vnum': vnum, 'lat': lat, 'lon': lon,
                'seismic_available': bool(parsed['seismic']),
                'infrasound_available': bool(parsed['infrasound']),
                'seismic_stations': seismic_summary,
                'infrasound_stations': infrasound_summary,
                'seismic_sample_rates': seismic_rates,
                'infrasound_sample_rates': infrasound_rates,
                'seismic_channels': parsed['seismic'],
                'infrasound_channels': parsed['infrasound'],
            })
        else:
            print("  ⚠️  No stations found")
            results.append({
                'name': name, 'vnum': vnum, 'lat': lat, 'lon': lon,
                'seismic_available': False, 'infrasound_available': False,
                'seismic_stations': 0, 'infrasound_stations': 0,
                'seismic_sample_rates': [], 'infrasound_sample_rates': []
            })

        time.sleep(0.5)
        if index % save_every == 0:
            with open(progress_json, 'w') as f:
                json.dump(results, f, indent=2)
            print(f"\n💾 Progress saved ({index}/{total})")

    write_outputs(repo_root, results)
    print('\n' + '=' * 80)
    print('✅ Complete! Results saved to data/reference')
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Audit IRIS station availability near monitored volcanoes')
    parser.add_argument('--limit', type=int, default=None, help='Limit number of volcanoes to process')
    parser.add_argument('--radius-km', type=float, default=50.0, help='Search radius in kilometers')
    args = parser.parse_args()

    audit_volcanoes(limit=args.limit, radius_km=args.radius_km)
