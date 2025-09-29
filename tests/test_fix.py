#!/usr/bin/env python3
"""
Test script to verify that the timezone handling fixes are working correctly.
"""

from main import main
from print_manager import print_manager

# Configure print manager for test
print_manager.show_times = True
print_manager.show_files = True
print_manager.show_api_requests = True
print_manager.show_data_info = True

print("Running test with all default settings...")
result = main(days=1, 
             sampling_rate=7500,
             marker_interval_hours=1,
             tick_interval_hours=1,
             use_am_pm=True,
             auto_open=False,  # Don't open files automatically for test
             markers_in_AKST=True)

if result:
    print("\n✅ Test passed! The script completed successfully.")
    print(f"Data time range: {result['time_range']}")
else:
    print("\n❌ Test failed! Check the error messages above.") 