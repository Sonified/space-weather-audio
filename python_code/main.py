#!/usr/bin/env python3
"""
Spurr Seismic Audification Tool

This script fetches seismic data from Mt. Spurr volcano, creates an audio file,
plots the data, and generates marker files for audio editors.
"""

import os
import argparse
from datetime import datetime, timedelta, timezone
import ipywidgets as widgets
from IPython.display import display
import subprocess

from python_code.seismic_utils import compute_time_window, fetch_seismic_data
from python_code.audio_utils import create_audio_file
from python_code.plot_utils import create_seismic_plot, show_stream_info
from python_code.marker_utils import generate_marker_file
from python_code.ui_utils import create_buttons_from_results, print_results_summary, display_marker_file_contents
from python_code.print_manager import print_manager

def parse_arguments():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(description="Spurr Seismic Audification Tool")
    parser.add_argument("--days", type=int, default=1, choices=[1, 2],
                        help="Number of days to fetch (1 or 2)")
    parser.add_argument("--sample-rate", type=int, default=7500,
                        help="Audio sample rate in Hz (default: 7500)")
    parser.add_argument("--marker-interval", type=int, default=1,
                        help="Hours between markers (default: 1)")
    parser.add_argument("--tick-interval", type=int, default=1,
                        help="Hours between plot ticks (default: 1)")
    parser.add_argument("--am-pm", action="store_true",
                        help="Use AM/PM format for markers")
    parser.add_argument("--no-open", action="store_true",
                        help="Don't automatically open files")
    parser.add_argument("--station", type=str, default="SPCN",
                        help="Station code (default: SPCN)")
    parser.add_argument("--network", type=str, default="AV",
                        help="Network code (default: AV)")
    parser.add_argument("--channel", type=str, default="BHZ",
                        help="Channel code (default: BHZ)")
    parser.add_argument("--utc-markers", action="store_false", dest="markers_in_AKST",
                        help="Use UTC time for markers instead of Alaska time")
    parser.add_argument("--interpolate", action="store_true", dest="interpolate_missing_data",
                        help="Interpolate missing data instead of filling with zeros")
    parser.add_argument("--quiet", action="store_true",
                        help="Reduce output verbosity")
    return parser.parse_args()

def main(days=1, sampling_rate=7500, marker_interval_hours=1, tick_interval_hours=1, 
         use_am_pm=True, quiet=False, auto_open=True, interpolate_missing_data=False,
         markers_in_AKST=True):
    """
    Main function to process seismic data, create visualization and audification
    
    Args:
        days (int): Number of days to look back from current time
        sampling_rate (int): Sampling rate for audio in Hz 
        marker_interval_hours (int): Interval between time markers in hours
        tick_interval_hours (int): Interval between x-axis ticks in hours
        use_am_pm (bool): Use AM/PM format for time markers
        quiet (bool): Reduce output verbosity
        auto_open (bool): Automatically open the created audio file
        interpolate_missing_data (bool): Interpolate missing data instead of filling with zeros
        markers_in_AKST (bool): Use Alaska time for markers instead of UTC

    Returns:
        dict: Dictionary containing file paths and processing results
    """
    # Set quiet mode if requested
    if quiet:
        print_manager.show_times = False
        print_manager.show_files = False
        print_manager.show_data_info = False
        print_manager.show_all_markers = False
    
    # Step 1: Compute time window
    start_str, end_str, end_time = compute_time_window(days)
    
    # Create directories if they don't exist
    mseed_dir = "mseed_files"
    audio_marker_dir = "Audio_Files"
    plot_dir = "Plot_Files"
    os.makedirs(mseed_dir, exist_ok=True)
    os.makedirs(audio_marker_dir, exist_ok=True)
    os.makedirs(plot_dir, exist_ok=True)
    
    # Create filenames with the format
    formatted_time = end_time.strftime('%Y-%m-%d_T_%H%M%S')
    mseed_file = os.path.join(mseed_dir, f"Spurr_Last_{days}d_{formatted_time}.mseed")
    audio_file = os.path.join(audio_marker_dir, f"Spurr_Last_{days}d_{formatted_time}.wav")
    marker_file = os.path.join(audio_marker_dir, f"Spurr_Last_{days}d_{formatted_time}_Marker_File.txt")
    plot_file = os.path.join(plot_dir, f"Spurr_Last_{days}d_{formatted_time}.png")
    
    # Step 2: Fetch seismic data
    st = fetch_seismic_data(start_str, end_str, mseed_file)
    if st is None:
        return {
            "success": False,
            "mseed_file": mseed_file,
            "audio_file": audio_file,
            "marker_file": marker_file,
            "plot_file": plot_file
        }
    
    # Step 3: Show stream information
    show_stream_info(st)
    
    # Step 4: Create plot
    create_seismic_plot(st, plot_file, days, end_time, tick_interval_hours)
    
    # Step 5: Create audio file
    fill_method = 'interpolate' if interpolate_missing_data else 'zeros'
    create_audio_file(st, sampling_rate, audio_file, fill_method=fill_method)
    
    # Step 6: Generate marker file
    generate_marker_file(st, marker_interval_hours, marker_file, use_am_pm=use_am_pm, markers_in_AKST=markers_in_AKST)
    
    # Store results in dictionary
    result = {
        "success": True,
        "mseed_file": mseed_file,
        "audio_file": audio_file,
        "marker_file": marker_file,
        "plot_file": plot_file,
        "data_length": len(st[0].data) if len(st) > 0 else 0,
        "time_range": f"{start_str} to {end_str}"
    }
    
    # Print summary and display buttons
    print_results_summary(result)
    
    # Create buttons
    buttons = create_buttons_from_results(result)
    
    # Display marker file contents
    if print_manager.show_all_markers:
        display_marker_file_contents(marker_file)
    
    # Auto-open the audio file if requested
    if auto_open:
        try:
            izotope_path = "/Applications/iZotope RX 11 Audio Editor.app/"
            if os.path.exists(izotope_path) and os.path.exists(audio_file):
                subprocess.run(['open', '-a', izotope_path, audio_file])
                if print_manager.show_status:
                    print(f"✅ Automatically opening {os.path.basename(audio_file)} with iZotope RX 11")
        except Exception as e:
            if print_manager.show_status:
                print(f"Error automatically opening audio file: {e}")
    
    return result

if __name__ == "__main__":
    from python_code import __version__
    print(f"🌋 Spurr Audification System v{__version__} - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    args = parse_arguments()
    main(days=args.days, 
         sampling_rate=args.sample_rate,
         marker_interval_hours=args.marker_interval,
         tick_interval_hours=args.tick_interval,
         use_am_pm=args.am_pm,
         quiet=args.quiet,
         auto_open=not args.no_open,
         interpolate_missing_data=args.interpolate_missing_data,
         markers_in_AKST=args.markers_in_AKST) 