import unittest
from datetime import datetime, timedelta
from obspy import UTCDateTime, Stream, Trace
import numpy as np
import os
import tempfile

# Import the modules we want to test
from seismic_time import compute_time_window
from audio_utils import generate_marker_file

class TestMarkerAlignment(unittest.TestCase):
    """Test class to verify marker file alignment with data range"""
    
    def setUp(self):
        """Set up test data and environment"""
        # Create temporary directory for test files
        self.test_dir = tempfile.TemporaryDirectory()
        self.marker_file = os.path.join(self.test_dir.name, "test_marker.txt")
        
        # Create a synthetic seismic stream spanning 24 hours
        self.start_time = UTCDateTime("2023-03-25T00:00:00")
        self.end_time = UTCDateTime("2023-03-25T23:59:59")
        
        # Create a trace with 1 hour of data (3600 samples at 1 Hz)
        data = np.zeros(86400)  # 24 hours at 1 Hz
        stats = {'network': 'AV', 'station': 'SPCN', 'channel': 'BHZ',
                 'starttime': self.start_time, 'sampling_rate': 1.0}
        trace = Trace(data=data, header=stats)
        self.st = Stream(traces=[trace])
        
        # Set intervals for testing
        self.marker_intervals = [1, 2, 3, 4, 6, 12, 24]  # Hours
    
    def tearDown(self):
        """Clean up after tests"""
        self.test_dir.cleanup()
    
    def test_marker_file_creation(self):
        """Test that marker file is created"""
        # Test with 1 hour interval
        generate_marker_file(self.st, 1, self.marker_file)
        self.assertTrue(os.path.exists(self.marker_file))
    
    def _parse_marker_file(self, filename):
        """Helper method to parse a marker file and return time points"""
        times = []
        with open(filename, 'r') as f:
            lines = f.readlines()
            # Skip header lines
            for line in lines[2:]:
                if line.strip():
                    parts = line.split('\t')
                    if len(parts) == 2:
                        times.append(parts[0])
        return times
    
    def test_marker_alignment_with_day_boundaries(self):
        """Test that markers align with day boundaries based on interval"""
        for interval in self.marker_intervals:
            # Generate marker file with the given interval
            generate_marker_file(self.st, interval, self.marker_file, use_am_pm=False)
            
            # Parse the marker file to get time points
            marker_times = self._parse_marker_file(self.marker_file)
            
            # Check for non-empty marker file
            self.assertTrue(len(marker_times) > 0, f"Marker file empty for interval {interval}")
            
            # Verify that time points are at expected intervals
            expected_hours = []
            for h in range(0, 24, interval):
                expected_hours.append(h)
            
            # Extract hours from marker times
            marker_hours = []
            for time_str in marker_times:
                # Format: MM/DD HH:MM
                try:
                    hour = int(time_str.split(' ')[1].split(':')[0])
                    marker_hours.append(hour)
                except (IndexError, ValueError):
                    # Skip malformed entries
                    continue
            
            # Verify hours match expected pattern
            for expected_hour in expected_hours:
                self.assertIn(expected_hour, marker_hours, 
                             f"Hour {expected_hour} missing for interval {interval}")
    
    def test_marker_range_matches_data_range(self):
        """Test that the marker file time range matches the data range"""
        # Generate marker file
        generate_marker_file(self.st, 1, self.marker_file)
        
        # Read the marker file to get first and last time
        with open(self.marker_file, 'r') as f:
            lines = f.readlines()[2:]  # Skip header
            
            # Extract first and last times
            first_marker = None
            last_marker = None
            
            if lines:
                # First valid marker
                for line in lines:
                    if '\t' in line:
                        first_marker = line.split('\t')[0]
                        break
                
                # Last valid marker
                for line in reversed(lines):
                    if '\t' in line:
                        last_marker = line.split('\t')[0]
                        break
            
            # Verify we found markers
            self.assertIsNotNone(first_marker, "No valid first marker found")
            self.assertIsNotNone(last_marker, "No valid last marker found")
            
            # Verify the date part matches the stream dates
            expected_date = "03/25"  # Month/day format
            self.assertTrue(first_marker.startswith(expected_date), 
                           f"First marker date {first_marker} does not match expected {expected_date}")
            self.assertTrue(last_marker.startswith(expected_date), 
                           f"Last marker date {last_marker} does not match expected {expected_date}")
    
    def test_compute_time_window(self):
        """Test the compute_time_window function for consistency"""
        # Test with 1 day lookback
        days = 1
        start_str, end_str, alaska_time = compute_time_window(days)
        
        # Parse the strings
        start_time = datetime.strptime(start_str, "%Y-%m-%dT%H:%M:%S")
        end_time = datetime.strptime(end_str, "%Y-%m-%dT%H:%M:%S")
        
        # Verify time difference is approximately days
        time_diff = end_time - start_time
        expected_diff = timedelta(days=days)
        
        # Allow for a small tolerance (1 minute)
        tolerance = timedelta(minutes=1)
        self.assertLess(abs(time_diff - expected_diff), tolerance, 
                       f"Time window {time_diff} does not match expected {expected_diff}")

if __name__ == '__main__':
    unittest.main() 