#!/usr/bin/env python3
"""
Simplified test for marker generation
"""

import unittest
from datetime import datetime, timedelta, timezone
from obspy import Stream, Trace
import numpy as np
import os

from audio_utils import generate_marker_file

class TestMarkerGeneration(unittest.TestCase):
    """Test class for marker generation"""
    
    def setUp(self):
        """Set up test data"""
        # Create a dummy stream with a small time range
        self.temp_dir = "test_output"
        os.makedirs(self.temp_dir, exist_ok=True)
        
        # Create start and end times (1 hour apart)
        self.start_time = datetime.now(timezone.utc) - timedelta(hours=1)
        self.end_time = datetime.now(timezone.utc)
        
        # Create a synthetic trace
        data = np.sin(np.linspace(0, 50 * np.pi, 3600))  # 1 sample per second for 1 hour
        
        # Create trace
        trace = Trace(data=data)
        trace.stats.starttime = self.start_time
        trace.stats.endtime = self.end_time
        trace.stats.sampling_rate = 1.0  # 1 Hz for simplicity
        trace.stats.network = "AV"
        trace.stats.station = "TEST"
        trace.stats.channel = "BHZ"
        
        # Create stream
        self.stream = Stream(traces=[trace])
        
        # Output marker file
        self.marker_file = os.path.join(self.temp_dir, "test_marker.txt")
    
    def test_short_interval_markers(self):
        """Test generating markers with a short interval"""
        # Generate markers with 10-minute intervals
        marker_interval = 10/60  # 10 minutes in hours
        
        # Create marker file
        generate_marker_file(self.stream, marker_interval, self.marker_file, use_am_pm=True)
        
        # Check if file was created
        self.assertTrue(os.path.exists(self.marker_file), "Marker file was not created")
        
        # Check content
        with open(self.marker_file, 'r') as f:
            lines = f.readlines()
        
        # Count actual markers (excluding header lines)
        marker_lines = [line for line in lines if '\t' in line]
        
        # We should have approximately 6 markers (10 minute intervals over 1 hour)
        # Allow some flexibility due to time alignment
        self.assertGreaterEqual(len(marker_lines), 5, "Too few markers generated")
        self.assertLessEqual(len(marker_lines), 7, "Too many markers generated")
        
        print(f"Short marker test: Created {len(marker_lines)} markers from "
              f"{self.start_time.strftime('%Y-%m-%d %H:%M:%S')} to "
              f"{self.end_time.strftime('%Y-%m-%d %H:%M:%S')}")

if __name__ == "__main__":
    unittest.main() 