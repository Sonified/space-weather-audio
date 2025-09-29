import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import os
from python_code.print_manager import print_manager

def setup_matplotlib_style():
    """Set up matplotlib style for consistent plots"""
    # Set larger default figure size
    plt.rcParams['figure.figsize'] = (12, 5)
    
    # Set larger font sizes for readability
    plt.rcParams['font.size'] = 12
    plt.rcParams['axes.titlesize'] = 14
    plt.rcParams['axes.labelsize'] = 12
    plt.rcParams['xtick.labelsize'] = 10
    plt.rcParams['ytick.labelsize'] = 10
    
    # Use a clean, modern style
    plt.style.use('seaborn-v0_8-whitegrid')
    
    # Set DPI for export
    plt.rcParams['savefig.dpi'] = 150

def show_stream_info(st):
    """
    Display basic information about a seismic stream
    
    Args:
        st (obspy.Stream): Seismic data stream
    """
    tr = st[0]  # Get first trace
    
    # Always print the original sampling rate from the data
    print(f"📊 Original Data Sampling Rate: {tr.stats.sampling_rate} Hz")
    
    print_manager.print_data(f"Number of traces: {len(st)}")
    print_manager.print_data(f"Data points in first trace: {len(tr.data)}")
    print_manager.print_data(f"Min/Max values: {tr.data.min()}, {tr.data.max()}")
    
    # Display time range
    print_manager.print_status(f"Sampling rate: {tr.stats.sampling_rate} Hz")
    print_manager.print_status(f"Start time: {tr.stats.starttime}")
    print_manager.print_status(f"End time: {tr.stats.endtime}")
    print_manager.print_status(f"Duration: {tr.stats.endtime - tr.stats.starttime} seconds")
    
    # Show first few amplitude values only if detailed data info is requested
    print_manager.print_data("First few amplitude values:")
    print_manager.print_data(str(tr.data[:5]))

def create_seismic_plot(st, plot_filename, days, end_time, tick_interval_hours=1):
    """
    Create a plot of seismic data
    
    Args:
        st (obspy.Stream): Seismic data
        plot_filename (str): Output plot file path
        days (int): Number of days of data
        end_time (datetime): End time of data in Alaska time
        tick_interval_hours (int): Hours between x-axis ticks
        
    Returns:
        str: Path to the created plot file
    """
    # Set up matplotlib style
    setup_matplotlib_style()
    
    # Create a direct matplotlib plot
    plt.figure(figsize=(16, 5))
    
    # Get the time array for x-axis
    tr = st[0]
    times = tr.times("matplotlib")  # Convert to matplotlib date format
    amplitude = tr.data
    
    # Plot the data directly
    plt.plot(times, amplitude)
    
    # Format x-axis
    plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%H:%M'))
    plt.gca().xaxis.set_major_locator(mdates.HourLocator(interval=tick_interval_hours))
    
    # Format the end time for the title (using Alaska time)
    formatted_end_time = end_time.strftime('%b %d %H:%M')  # end_time is already in Alaska time
    
    # Add labels and title with date information
    plt.title(f"Spurr Seismic Data (SPCN) - Last {days} day(s) before {formatted_end_time} Alaska Time")
    plt.ylabel("Amplitude")
    plt.grid(True, alpha=0.3)
    
    # Make sure everything fits
    plt.tight_layout()
    
    # Ensure directory exists
    os.makedirs(os.path.dirname(plot_filename), exist_ok=True)
    
    # Save and show
    plt.savefig(plot_filename)
    print_manager.print_file(f"✅ Saved plot file: {plot_filename}")
    
    return plot_filename 