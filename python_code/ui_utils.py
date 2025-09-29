import os
import subprocess
import ipywidgets as widgets
from IPython.display import display
from python_code.print_manager import print_manager


def create_directory_button(directory_path):
    """Create a button that opens a directory when clicked"""
    button = widgets.Button(description="Open Directory")
    
    def on_click(b):
        try:
            subprocess.run(['open', directory_path])
            if print_manager.show_buttons:
                print(f"Opening directory: {directory_path}")
        except Exception as e:
            print(f"Error opening directory: {e}")
    
    button.on_click(on_click)
    return button


def create_audio_open_button(audio_path, app_path="/Applications/iZotope RX 11 Audio Editor.app/"):
    """Create a button that opens an audio file with the specified application"""
    button = widgets.Button(description="Open Audio in RX 11")
    
    def on_click(b):
        try:
            subprocess.run(['open', '-a', app_path, audio_path])
            if print_manager.show_buttons:
                print(f"Opening audio file: {os.path.basename(audio_path)}")
        except Exception as e:
            print(f"Error opening audio file: {e}")
    
    button.on_click(on_click)
    return button


def create_marker_file_button(marker_path):
    """Create a button that opens a marker file"""
    button = widgets.Button(description="Open Marker File")
    
    def on_click(b):
        try:
            subprocess.run(['open', marker_path])
            if print_manager.show_buttons:
                print(f"Opening marker file: {os.path.basename(marker_path)}")
        except Exception as e:
            print(f"Error opening marker file: {e}")
    
    button.on_click(on_click)
    return button


def create_plot_file_button(plot_path):
    """Create a button that opens a plot image"""
    button = widgets.Button(description="Open Plot Image")
    
    def on_click(b):
        try:
            subprocess.run(['open', plot_path])
            if print_manager.show_buttons:
                print(f"Opening plot image: {os.path.basename(plot_path)}")
        except Exception as e:
            print(f"Error opening plot image: {e}")
    
    button.on_click(on_click)
    return button


def create_buttons_from_results(result):
    """Create and display all buttons based on results dictionary"""
    # Create buttons
    directory_button = create_directory_button(os.path.dirname(result['audio_file']))
    audio_button = create_audio_open_button(result['audio_file'])
    marker_button = create_marker_file_button(result['marker_file'])
    plot_button = create_plot_file_button(result['plot_file'])
    
    # Display buttons
    display(directory_button)
    display(audio_button)
    display(marker_button)
    display(plot_button)
    
    return {
        'directory_button': directory_button,
        'audio_button': audio_button,
        'marker_button': marker_button,
        'plot_button': plot_button
    }


def display_marker_file_contents(marker_file_path):
    """Display the contents of a marker file"""
    if os.path.exists(marker_file_path):
        with open(marker_file_path, 'r') as f:
            marker_content = f.readlines()
            print(f"\nMarker file contains {len(marker_content)-2} markers")
            print("First few markers:")
            for line in marker_content[:5]:
                print(line.strip())
            if len(marker_content) > 7:
                print("...")
            print("Last few markers:")
            for line in marker_content[-3:]:
                print(line.strip())
    else:
        print("Marker file not found")


def print_results_summary(result):
    """Print a summary of the processing results"""
    if print_manager.show_files:
        print("\n== Processing Summary ==")
        print(f"MSEED file: {result['mseed_file']}")
        print(f"Audio file: {result['audio_file']}")
        print(f"Marker file: {result['marker_file']}")
        print(f"Plot file: {result['plot_file']}") 