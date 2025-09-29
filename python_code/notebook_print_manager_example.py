# Example code to add to Spurr_Audification.ipynb

# Import the print manager
from print_manager import print_manager

# Display current settings
print_manager.display_settings()

# Configure print options based on your preferences
# For minimal output with focus on buttons:
print_manager.show_times = False      # Hide timestamp messages
print_manager.show_files = True       # Show file paths
print_manager.show_buttons = True     # Show UI buttons
print_manager.show_marker_summary = False  # Hide marker summary
print_manager.show_data_info = False  # Hide detailed data info

# To restore the open folder button, make sure this is enabled
print_manager.show_buttons = True

# Configuration parameters
config = {
    "days": 1,               # Number of days to process
    "sampling_rate": 7500,   # Audio sampling rate in Hz
    "tick_interval_hours": 1, # X-axis tick interval for plot
    "marker_interval_hours": 1, # Interval for audio markers
    "use_am_pm": True,        # Use AM/PM format in marker file
    "markers_in_AKST": True   # Use Alaska time for markers
}

# Run the main function with our config
result = main(**config)

# You can still create buttons manually if needed
# Create UI buttons
def open_marker_file(b):
    try:
        subprocess.run(['open', result['marker_file']])
    except Exception as e:
        print(f"Error opening marker file: {e}")

def open_containing_dir(b):
    try:
        # Get the directory where the files are saved
        directory = os.path.dirname(os.path.abspath(result['audio_file']))
        subprocess.run(['open', directory])
    except Exception as e:
        print(f"Error opening directory: {e}")

# Display buttons
import ipywidgets as widgets
from IPython.display import display

marker_button = widgets.Button(description="Open Marker File")
marker_button.on_click(open_marker_file)

dir_button = widgets.Button(description="Open Files Folder")
dir_button.on_click(open_containing_dir)

display(marker_button)
display(dir_button) 