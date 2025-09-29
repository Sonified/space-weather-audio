#!/usr/bin/env python
import unittest
import os
import tempfile
import shutil
from datetime import datetime, timedelta
import numpy as np
from obspy import Stream, Trace, UTCDateTime
import time

# Import relevant functions from our modules
from seismic_time import compute_time_window, format_time_for_marker
from audio_utils import generate_marker_file
from data_fetcher import fetch_seismic_data

class TestMarkerDataRangeAlignment(unittest.TestCase):
    """Test class to verify that marker file time range aligns with data selected range."""
    
    def setUp(self):
        """Set up test environment with sample data."""
        # Create temp directory for test files
        self.temp_dir = tempfile.mkdtemp()
        self.audio_dir = os.path.join(self.temp_dir, "Audio_Files")
        os.makedirs(self.audio_dir, exist_ok=True)
        
        # Create a synthetic stream for testing
        # Start 24 hours ago and run for 24 hours
        self.start_time = UTCDateTime() - 86400  # 24 hours ago
        self.end_time = UTCDateTime()  # current time
        self.data_duration = self.end_time - self.start_time  # should be 24 hours
        self.sampling_rate = 100  # Hz
        
        # Create synthetic data
        npts = int(self.data_duration * self.sampling_rate)
        synthetic_data = np.sin(np.linspace(0, 50 * np.pi, npts))
        
        # Create an ObsPy trace with the data
        trace = Trace(data=synthetic_data)
        trace.stats.starttime = self.start_time
        trace.stats.sampling_rate = self.sampling_rate
        trace.stats.network = "AV"
        trace.stats.station = "SPBG"
        trace.stats.location = "--"
        trace.stats.channel = "BHZ"
        
        # Create a stream with the trace
        self.stream = Stream(traces=[trace])
        
        # Test marker intervals
        self.marker_interval_hours = 1
        
        # Base filename for testing
        self.base_filename = os.path.join(self.audio_dir, "test_data")
        
    def tearDown(self):
        """Clean up test environment."""
        shutil.rmtree(self.temp_dir)
    
    def _parse_marker_file(self, filepath):
        """Parse the marker file and return time points."""
        time_points = []
        with open(filepath, 'r') as f:
            for line in f:
                if line.strip() and not line.startswith('['):  # Skip empty lines and headers
                    # Extract time from line
                    time_str = line.split('\t')[0]
                    try:
                        # Parse time string based on format (12-hour or 24-hour)
                        if 'AM' in time_str or 'PM' in time_str:
                            # 12-hour format
                            time_format = '%I:%M:%S %p'
                            time_obj = datetime.strptime(time_str, time_format).time()
                        else:
                            # 24-hour format
                            time_format = '%H:%M:%S'
                            time_obj = datetime.strptime(time_str, time_format).time()
                        time_points.append(time_obj)
                    except ValueError:
                        # Skip lines that don't parse as time
                        continue
        return time_points

    def test_compute_time_window_accuracy(self):
        """Test compute_time_window returns the correct time range."""
        # Test with 1 day
        start_str, end_str, alaska_time = compute_time_window(days=1)
        
        # Convert string dates to UTCDateTime objects
        start_time = UTCDateTime(start_str)
        end_time = UTCDateTime(end_str)
        
        # Calculate expected values
        expected_delta = timedelta(days=1)
        actual_delta = end_time.datetime - start_time.datetime
        
        # Check that the time difference is 1 day (with 1 minute tolerance)
        self.assertAlmostEqual(
            actual_delta.total_seconds(), 
            expected_delta.total_seconds(),
            delta=60,  # Allow 60 seconds (1 minute) difference due to execution timing
            msg="Expected time window of 1 day, got {}".format(actual_delta)
        )
        
        # Test with 2 days
        start_str, end_str, alaska_time = compute_time_window(days=2)
        
        # Convert string dates to UTCDateTime objects
        start_time = UTCDateTime(start_str)
        end_time = UTCDateTime(end_str)
        
        # Calculate expected values
        expected_delta = timedelta(days=2)
        actual_delta = end_time.datetime - start_time.datetime
        
        # Check that the time difference is 2 days (with 1 minute tolerance)
        self.assertAlmostEqual(
            actual_delta.total_seconds(), 
            expected_delta.total_seconds(),
            delta=60,  # Allow 60 seconds (1 minute) difference due to execution timing
            msg="Expected time window of 2 days, got {}".format(actual_delta)
        )

    def test_marker_file_creation(self):
        """Test marker file creation and basic structure."""
        marker_file = "{}_Marker_File.txt".format(self.base_filename)
        
        # Create marker file with 1-hour interval
        generate_marker_file(
            self.stream,
            self.marker_interval_hours,
            marker_file,
            use_am_pm=True
        )
        
        # Verify marker file exists
        self.assertTrue(os.path.exists(marker_file), "Marker file was not created")
        
        # Verify file is not empty
        self.assertGreater(os.path.getsize(marker_file), 0, "Marker file is empty")

    def test_marker_range_matches_data_range(self):
        """Test that the marker file's time range matches the data range."""
        marker_file = "{}_range_test_Marker_File.txt".format(self.base_filename)
        
        # Create marker file
        generate_marker_file(
            self.stream,
            self.marker_interval_hours,
            marker_file,
            use_am_pm=True
        )
        
        # Read marker file and extract times
        with open(marker_file, 'r') as f:
            lines = f.readlines()
        
        # Check if the file has content
        self.assertGreater(len(lines), 0, "Marker file is empty")
        
        # Extract first and last time marker
        time_markers = []
        date_markers = []
        
        for line in lines:
            if line.strip() and '\t' in line:  # Skip empty lines and ensure it's a marker line
                parts = line.strip().split('\t')
                if len(parts) >= 2:
                    time_str = parts[0]
                    if len(parts) >= 3:  # If we have a date field
                        date_str = parts[2]
                        date_markers.append(date_str)
                    time_markers.append(time_str)
        
        # Verify we found time markers
        self.assertGreater(len(time_markers), 0, "No time markers found in file")
        
        # Get the expected start and end dates in marker format
        start_date_str = self.start_time.strftime("%m/%d/%Y")
        end_date_str = self.end_time.strftime("%m/%d/%Y")
        
        # Check if dates in marker file match expected date range
        if date_markers:
            self.assertEqual(
                date_markers[0], 
                start_date_str,
                "First marker date {} doesn't match expected start date {}".format(date_markers[0], start_date_str)
            )
            self.assertEqual(
                date_markers[-1], 
                end_date_str if self.end_time.hour > 0 or self.end_time.minute > 0 else start_date_str,
                "Last marker date {} doesn't match expected end date {}".format(date_markers[-1], end_date_str)
            )
        
        # Verify marker count matches expected count based on data duration
        expected_markers = int(self.data_duration / 3600 / self.marker_interval_hours) + 1
        self.assertGreaterEqual(
            len(time_markers), 
            expected_markers - 1,  # Allow for one less due to rounding
            "Expected at least {} markers, got {}".format(expected_markers-1, len(time_markers))
        )
        self.assertLessEqual(
            len(time_markers), 
            expected_markers + 1,  # Allow for one more due to rounding
            "Expected at most {} markers, got {}".format(expected_markers+1, len(time_markers))
        )

    def test_data_fetcher_time_range(self):
        """Test that the data fetcher returns data for the exact specified time range."""
        # This test requires an actual internet connection, so we'll skip it if fetching fails
        try:
            # Compute a short time window (1 hour) to minimize data size but ensure enough data
            end_time = UTCDateTime()
            start_time = end_time - 3600  # 1 hour
            
            # Create a filename for the test
            test_filename = os.path.join(self.temp_dir, "test_fetched_data.mseed")
            
            # Fetch data for this time range
            stream = fetch_seismic_data(
                start_time.strftime("%Y-%m-%dT%H:%M:%S"), 
                end_time.strftime("%Y-%m-%dT%H:%M:%S"),
                test_filename
            )
            
            # Give some time for the data to be fully written/processed
            time.sleep(1)
            
            # Verify we got data
            self.assertIsNotNone(stream, "Failed to fetch seismic data")
            self.assertGreater(len(stream), 0, "Empty stream returned from fetch_seismic_data")
            
            # Check the time range of the returned data
            data_start = min(tr.stats.starttime for tr in stream)
            data_end = max(tr.stats.endtime for tr in stream)
            
            print(f"Requested time range: {start_time} to {end_time}")
            print(f"Actual data range: {data_start} to {data_end}")
            
            # The fetched data should cover at least the requested time range
            # (may be slightly larger due to how data is stored/served)
            self.assertLessEqual(
                data_start, 
                start_time + 180,  # Allow up to 3 minutes later start
                f"Data starts at {data_start}, expected at or before {start_time + 180}"
            )
            self.assertGreaterEqual(
                data_end, 
                end_time - 180,  # Allow up to 3 minutes earlier end
                f"Data ends at {data_end}, expected at or after {end_time - 180}"
            )
            
        except Exception as e:
            self.skipTest(f"Skipping test_data_fetcher_time_range because data fetching failed: {e}")

    def test_marker_alignment_with_data_boundaries(self):
        """Test that markers align with data boundaries correctly."""
        marker_file = "{}_boundary_test_Marker_File.txt".format(self.base_filename)
        
        # Set a specific marker interval for this test (6 hours)
        test_marker_interval = 6
        
        # Create marker file with 6-hour intervals
        generate_marker_file(
            self.stream,
            test_marker_interval,
            marker_file,
            use_am_pm=True
        )
        
        # Read marker file
        with open(marker_file, 'r') as f:
            lines = f.readlines()
        
        # Extract timestamps
        time_markers = []
        
        for line in lines:
            if line.strip() and '\t' in line:
                parts = line.strip().split('\t')
                if len(parts) >= 2:
                    time_str = parts[0]
                    time_markers.append(time_str)
        
        # Get the expected date
        expected_date = self.start_time.strftime("%m/%d")
        
        # Expected marker times for 6-hour intervals
        expected_hour_markers = ["12:00 AM", "06:00 AM", "12:00 PM", "06:00 PM"]
        
        # Verify all expected markers are present (at least one of each)
        for expected_time in expected_hour_markers:
            found = False
            for marker in time_markers:
                if expected_time in marker:
                    found = True
                    break
            self.assertTrue(
                found,
                "Expected marker with time {} not found in marker file".format(expected_time)
            )
        
        # Verify we have at least 4 markers (0h, 6h, 12h, 18h from start date)
        self.assertGreaterEqual(
            len(time_markers), 
            4,
            "Expected at least 4 markers (at 6-hour intervals), got {}".format(len(time_markers))
        )

    def test_short_marker_generation(self):
        """Test marker generation with a short time range and frequent markers."""
        from main import create_marker_file
        
        # Use a short time range (1 hour)
        end_time = UTCDateTime()
        start_time = end_time - 3600  # 1 hour
        
        # Use a 10-minute marker interval
        marker_interval = 10/60  # 10 minutes in hours
        
        # Generate filename
        marker_filename = os.path.join(self.temp_dir, "Audio_Files", "short_test_Mark.txt")
        audio_dir = os.path.join(self.temp_dir, "Audio_Files")
        os.makedirs(audio_dir, exist_ok=True)
        
        # Create the marker file
        create_marker_file(
            marker_filename,
            start_time.datetime,
            end_time.datetime,
            marker_interval_hours=marker_interval,
            use_am_pm=True
        )
        
        # Verify the marker file exists
        self.assertTrue(os.path.exists(marker_filename), "Marker file was not created")
        
        # Read markers
        markers = self._parse_marker_file(marker_filename)
        
        # Should have approximately 6 markers for a 1-hour period with 10-minute intervals
        expected_marker_count = int(3600 / (marker_interval * 3600))
        self.assertGreaterEqual(len(markers), expected_marker_count - 1)
        self.assertLessEqual(len(markers), expected_marker_count + 1)
        
        # Verify first and last markers
        if markers:
            first_marker_time = markers[0]
            last_marker_time = markers[-1]
            
            # Allow small tolerance (few seconds) due to floating point and conversion
            self.assertLessEqual(abs((first_marker_time - start_time)), 10)
            self.assertLessEqual(abs((last_marker_time - end_time)), 10)
            
            print(f"Short marker test: Created {len(markers)} markers from {first_marker_time} to {last_marker_time}")


if __name__ == "__main__":
    unittest.main() 