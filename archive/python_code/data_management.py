import json
from pathlib import Path

def filter_actual_volcanoes(volcano_list):
    """Remove regional aggregate entries, keep only specific volcanoes"""
    return [v for v in volcano_list if v.get('vnum') is not None and v.get('vnum') != ""]

def get_monitored_volcanoes(force_refresh=False):
    """
    Fetches the list of monitored volcanoes from the local JSON file.
    Filters out regional aggregate entries to return only specific volcanoes.
    """
    # Path to the local JSON file (robust to current working directory)
    repo_root = Path(__file__).resolve().parent.parent
    file_path = repo_root / 'reference' / 'monitored_volcanoes.json'

    try:
        with open(file_path, 'r') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"Error: The file {file_path} was not found.")
        return []
    except json.JSONDecodeError:
        print(f"Error: Could not decode JSON from the file {file_path}.")
        return []

    # Filter to actual volcanoes only
    actual_volcanoes = filter_actual_volcanoes(data)
    
    return actual_volcanoes

def derive_active_stations(output_path: Path | None = None):
    """
    Read data/reference/volcano_station_availability.json and write
    data/reference/active_volcano_stations.json with only channels whose
    end_time is empty (or missing).

    Returns (output_file_path, active_list).
    """
    repo_root = Path(__file__).resolve().parent.parent
    availability_path = repo_root / 'data' / 'reference' / 'volcano_station_availability.json'
    if not availability_path.exists():
        raise FileNotFoundError(f"Availability file not found: {availability_path}")

    with open(availability_path, 'r') as f:
        availability = json.load(f)

    from datetime import datetime

    def is_active_end(end_time_str: str | None, now_utc: datetime) -> bool:
        if not end_time_str:
            return True
        # Treat far-future sentinels as active
        try:
            year = int(end_time_str[:4])
            if year >= 2500:
                return True
        except Exception:
            pass
        # Parse ISO-like strings such as 2025-09-13T02:00:00.0000
        try:
            ts = end_time_str
            if '.' in ts:
                ts = ts.split('.')[0]
            dt = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S")
            # Assume timestamps are UTC from IRIS station text
            return dt > now_utc
        except Exception:
            return False

    now_utc = datetime.utcnow()

    active = []
    for entry in availability:
        name = entry.get('name')
        vnum = entry.get('vnum')
        volcano_lat = entry.get('lat')
        volcano_lon = entry.get('lon')

        for ch in entry.get('seismic_channels', []) or []:
            end_time = ch.get('end_time')
            if is_active_end(end_time, now_utc):
                item = {
                    'type': 'seismic',
                    'volcano': name,
                    'vnum': vnum,
                    'volcano_lat': volcano_lat,
                    'volcano_lon': volcano_lon,
                }
                item.update(ch)
                active.append(item)

        for ch in entry.get('infrasound_channels', []) or []:
            end_time = ch.get('end_time')
            if is_active_end(end_time, now_utc):
                item = {
                    'type': 'infrasound',
                    'volcano': name,
                    'vnum': vnum,
                    'volcano_lat': volcano_lat,
                    'volcano_lon': volcano_lon,
                }
                item.update(ch)
                active.append(item)

    out_dir = repo_root / 'data' / 'reference'
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_path or (out_dir / 'active_volcano_stations.json')
    with open(out_path, 'w') as f:
        json.dump(active, f, indent=2)

    return out_path, active

if __name__ == '__main__':
    volcanoes = get_monitored_volcanoes()
    if volcanoes:
        print("Filtered list of actual volcanoes:")
        for volcano in volcanoes:
            print(f"- {volcano.get('volcano_name')} (vnum: {volcano.get('vnum')})")
    else:
        print("No volcano data to display.")
