#!/usr/bin/env python3
"""
Test script to call backfill-station endpoint for MOKD station
"""
import requests
import json

url = "http://localhost:5005/backfill-station"
data = {
    "network": "HV",
    "volcano": "maunaloa",
    "station": "MOKD",
    "location": "--",
    "channel": "HHZ",
    "hours_back": 24
}

print("🔄 Calling backfill-station endpoint...")
print(f"Request: {json.dumps(data, indent=2)}\n")

response = requests.post(url, json=data, stream=True)

print(f"Status: {response.status_code}\n")

if response.status_code == 200:
    print("📡 Streaming response:\n")
    for line in response.iter_lines():
        if line:
            decoded = line.decode('utf-8')
            if decoded.startswith('data: '):
                event_data = json.loads(decoded[6:])
                if event_data.get('type') == 'progress':
                    msg = event_data.get('message', '')
                    if msg:
                        print(f"  {msg}")
                elif event_data.get('type') == 'complete':
                    print(f"\n✅ Complete!")
                    print(f"  Progress: {event_data.get('progress')}")
else:
    print(f"Error: {response.text}")


