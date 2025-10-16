import os
from scipy.io import wavfile
from datetime import datetime, timedelta, timezone
import subprocess
import numpy as np
from python_code.print_manager import print_manager

def normalize_data(data, target_amplitude=0.9):
    """
    Normalize audio data to a target amplitude
    
    Args:
        data (numpy.ndarray): Input data array
        target_amplitude (float): Target amplitude (0.0 to 1.0)
        
    Returns:
        numpy.ndarray: Normalized data
    """
    max_amplitude = max(abs(np.max(data)), abs(np.min(data)))
    if max_amplitude > 0:
        normalization_factor = target_amplitude / max_amplitude
        normalized_data = data * normalization_factor
        return normalized_data
    return data

def create_audio_file(st, sampling_rate, audio_filename, fill_method='zeros'):
    """
    Convert seismic data to audio file
    
    Args:
        st (obspy.Stream): Seismic data
        sampling_rate (int): Audio sampling rate in Hz
        audio_filename (str): Output audio file path
        fill_method (str): How to handle masked arrays - 'zeros' (default) or 'interpolate'
        
    Returns:
        str: Path to the created audio file
    """
    # Use the first trace in the stream (make a copy to avoid modifying original)
    tr = st[0].copy()
    
    # Pre-process the data to remove DC offset and reduce edge effects
    tr.detrend('demean')  # Remove mean (DC offset)
    tr.taper(max_percentage=0.0001)  # Apply taper to reduce edge effects
    
    # Set the sampling rate directly on the trace
    tr.stats.sampling_rate = sampling_rate
    
    # Handle masked arrays if present
    data = tr.data
    
    # Check if we have a masked array
    if isinstance(data, np.ma.MaskedArray):
        print_manager.print_status("Detected masked array in seismic data")
        
        if fill_method == 'zeros':
            # Fill masked values with zeros (default)
            print_manager.print_status("Filling masked values with zeros")
            data = data.filled(0)
            # To use linear interpolation instead, call with:
            # create_audio_file(st, sampling_rate, audio_filename, fill_method='interpolate')
        
        elif fill_method == 'interpolate':
            # Use linear interpolation to fill masked values
            print_manager.print_status("Using linear interpolation for masked values")
            
            # Get the mask and indices
            mask = data.mask
            indices = np.arange(len(data))
            
            # Get valid (non-masked) data points
            valid_indices = indices[~mask]
            valid_data = data.data[~mask]  # Use .data to get underlying array
            
            # If we have valid points, interpolate
            if len(valid_data) > 0:
                # Create interpolation function using only valid points
                from scipy import interpolate
                f_interp = interpolate.interp1d(
                    valid_indices, valid_data,
                    bounds_error=False,  # Don't raise error for out-of-bounds
                    fill_value=(valid_data[0], valid_data[-1])  # Fill edges with nearest values
                )
                
                # Interpolate all points
                filled_data = f_interp(indices)
                data = filled_data
            else:
                # If all points are masked, fall back to zeros
                print_manager.print_status("Warning: All data points are masked, falling back to zeros")
                data = np.zeros_like(data.data)
        else:
            # Unknown method, fall back to zeros
            print_manager.print_status(f"Unknown fill method '{fill_method}', using zeros")
            data = data.filled(0)
    
    # Make sure data is float for normalization
    data = data.astype(float)
    
    # Normalize amplitude to range [-1, 1] for audio
    max_amp = max(abs(data))
    if max_amp > 0:  # Avoid division by zero
        data = data / max_amp
    
    # Convert to 16-bit PCM
    audio_data = (data * 32767).astype('int16')
    
    # Create directory if it doesn't exist
    os.makedirs(os.path.dirname(audio_filename), exist_ok=True)
    
    # Write as WAV file
    wavfile.write(audio_filename, int(tr.stats.sampling_rate), audio_data)
    print_manager.print_file(f"✅ Saved audio file: {audio_filename}")
    
    return audio_filename

def generate_marker_file(stream, marker_interval_hours, marker_filename, use_am_pm=True, markers_timezone="UTC"):
    """
    Generate a marker file for audio editors
    
    Args:
        stream (obspy.Stream): Seismic data
        marker_interval_hours (float): Interval between markers in hours
        marker_filename (str): Output marker file path
        use_am_pm (bool): Whether to use AM/PM format instead of 24h
        markers_timezone (str): Timezone for markers ("UTC", "America/Anchorage", "Pacific/Honolulu", etc.)
        
    Returns:
        str: Path to the created marker file
    """
    # Ensure the directory exists
    os.makedirs(os.path.dirname(marker_filename), exist_ok=True)
    
    # Get start and end times from stream
    start_time_utc = stream[0].stats.starttime
    end_time_utc = stream[0].stats.endtime
    
    # Calculate the sampling rate
    sampling_rate = stream[0].stats.sampling_rate
    
    # Convert to Python datetime objects
    start_time_py = datetime(
        start_time_utc.year, start_time_utc.month, start_time_utc.day,
        start_time_utc.hour, start_time_utc.minute, start_time_utc.second
    )
    
    end_time_py = datetime(
        end_time_utc.year, end_time_utc.month, end_time_utc.day,
        end_time_utc.hour, end_time_utc.minute, end_time_utc.second
    )
    
    # Convert to Alaska time if requested
    ak_offset = timedelta(hours=-8)  # Use -9 for standard time, -8 for daylight saving
    
    if markers_in_AKST:
        start_time = start_time_py + ak_offset
        end_time = end_time_py + ak_offset
        
        # Print the time range in Alaska time
        print_manager.print_marker(f"Marker file time range: {start_time.strftime('%Y-%m-%d %H:%M:%S')} to {end_time.strftime('%Y-%m-%d %H:%M:%S')} Alaska time")
    else:
        start_time = start_time_py
        end_time = end_time_py
        
        # Print the time range in UTC
        print_manager.print_marker(f"Marker file time range: {start_time.strftime('%Y-%m-%d %H:%M:%S')} to {end_time.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    
    # Write the marker file
    with open(marker_filename, 'w') as f:
        # Write header lines
        f.write("Marker file version: 1\n")
        f.write("Time format: Samples\n")
        
        # Start with the first marker at the beginning of the data
        current_hour = start_time.hour
        
        # Round to the nearest marker interval if needed
        # For example, if we start at 08:45 and marker interval is 1 hour,
        # we want the first marker at 09:00
        if marker_interval_hours >= 1:
            minutes_to_next_hour = 60 - start_time.minute
            if minutes_to_next_hour < 60:  # If not already at the hour
                # Calculate the next even hour
                current_time = start_time + timedelta(minutes=minutes_to_next_hour)
                current_time = current_time.replace(second=0, microsecond=0)
            else:
                current_time = start_time
        else:
            # For sub-hour intervals, align to the start time
            current_time = start_time
        
        # If the current_time is still before our data starts, find the next marker time
        if current_time < start_time:
            # Calculate the time to the next marker
            # Round up to the next marker interval
            current_time = start_time.replace(minute=0, second=0, microsecond=0)
            current_time = current_time.replace(hour=0)  # Start from midnight
            current_time = current_time + timedelta(hours=current_hour)  # Add the hours back
            
            if minutes_to_next_hour < 60:  # If not already at the hour
                current_time = current_time + timedelta(hours=1)  # Skip to next hour
                
            # Then advance by intervals until we're beyond start_time
            while current_time < start_time:
                current_time += timedelta(hours=marker_interval_hours)
        
        # Now we have the first valid marker time after start_time
        # Write markers at the specified interval
        marker_count = 0
        while current_time <= end_time:
            hour = current_time.hour
            if use_am_pm:
                formatted_time = current_time.strftime(f'%m/%d %I:%M %p')
            else:
                formatted_time = current_time.strftime(f'%m/%d %H:%M')
            
            # Calculate sample position
            # If using Alaska time, convert back to UTC for comparison
            if markers_in_AKST:
                current_time_utc = current_time - ak_offset
            else:
                current_time_utc = current_time
                
            seconds_from_start = (current_time_utc - start_time_py).total_seconds()
            current_sample = int(seconds_from_start * sampling_rate)
            
            # Only write the marker if it falls within the data range
            if 0 <= current_sample <= len(stream[0].data):
                f.write(f"{formatted_time}\t{current_sample}\n")
                marker_count += 1
            
            # Move to next marker time
            current_time += timedelta(hours=marker_interval_hours)
            
            # If we cross over to a new day, realign to the proper hour pattern
            if current_time.hour < (current_time - timedelta(hours=marker_interval_hours)).hour:
                # We crossed midnight - align to midnight + interval pattern
                current_time = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Write the end marker if it doesn't align with the interval markers
        end_hour = end_time.hour
        if use_am_pm:
            formatted_end_time = end_time.strftime(f'%m/%d %I:%M %p')
        else:
            formatted_end_time = end_time.strftime(f'%m/%d %H:%M')
        end_sample = len(stream[0].data) - 1
        
        # Only write if the last interval marker isn't already at the end
        last_marker_time = current_time - timedelta(hours=marker_interval_hours)
        last_marker_seconds = (last_marker_time - end_time).total_seconds()
        if abs(last_marker_seconds) > 60:  # If more than 1 minute difference
            f.write(f"{formatted_end_time}\t{end_sample}\n")
            marker_count += 1
    
    if markers_in_AKST:
        timezone_str = "Alaska time"
    else:
        timezone_str = "UTC"
        
    print_manager.print_file(f"✅ Generated marker file: {marker_filename} with {timezone_str} markers")
    print_manager.print_marker(f"Created {marker_count} markers from {start_time.strftime('%I:%M %p')} to {end_time.strftime('%I:%M %p')}")
    
    return marker_filename

def open_audio_file(filename, app_path=None):
    """
    Open an audio file with the specified application
    
    Args:
        filename (str): Path to audio file
        app_path (str, optional): Path to application to open the file
        
    Returns:
        bool: Success status
    """
    try:
        if app_path:
            # Open with specified application
            subprocess.run(['open', '-a', app_path, filename])
            print_manager.print_status(f"✅ Opened {os.path.basename(filename)} with {os.path.basename(app_path)}")
        else:
            # Open with default application
            subprocess.run(['open', filename])
            print_manager.print_status(f"✅ Opened {os.path.basename(filename)}")
        return True
    except Exception as e:
        print_manager.print_status(f"❌ Error opening audio file: {e}")
        return False

def open_containing_directory(filename):
    """
    Open the directory containing a file
    
    Args:
        filename (str): Path to file
        
    Returns:
        bool: Success status
    """
    try:
        directory = os.path.dirname(os.path.abspath(filename))
        subprocess.run(['open', directory])
        print_manager.print_status(f"✅ Opened directory: {directory}")
        return True
    except Exception as e:
        print_manager.print_status(f"❌ Error opening directory: {e}")
        return False 