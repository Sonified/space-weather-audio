# This file makes the python_code directory a Python package
__version__ = "1.32"
__commit_message__ = (
    "v1.32 Feature: High-pass filter dropdown (None/0.01Hz/0.045Hz), base sampling rate multiplier (44.1k-1MHz), backend filtering, optimized loop reset (read pointer only), comprehensive fade/loop logging"
)

# Import key modules to make them available when importing the package
from python_code.main import main
from python_code.audio_utils import create_audio_file, generate_marker_file
from python_code.seismic_utils import compute_time_window, fetch_seismic_data
from python_code.plot_utils import create_seismic_plot
from python_code.marker_utils import generate_marker_file
from python_code.print_manager import print_manager
from python_code.ui_utils import (
    create_directory_button,
    create_audio_open_button,
    create_marker_file_button,
    create_plot_file_button,
    create_buttons_from_results,
    display_marker_file_contents,
    print_results_summary
)
