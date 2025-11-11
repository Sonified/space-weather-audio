import os
from datetime import datetime, timedelta, timezone
from python_code.print_manager import print_manager

def generate_marker_file(stream, marker_interval_hours, marker_filename, use_am_pm=True, markers_timezone="UTC"):
    """
    Generate a marker file for audio editors with timestamps aligned to intervals
    
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
    
    # Convert to Python datetime objects (timezone-naive for calculations)
    start_time_py = datetime(
        start_time_utc.year, start_time_utc.month, start_time_utc.day,
        start_time_utc.hour, start_time_utc.minute, start_time_utc.second
    )
    
    end_time_py = datetime(
        end_time_utc.year, end_time_utc.month, end_time_utc.day,
        end_time_utc.hour, end_time_utc.minute, end_time_utc.second
    )
    
    # Import pytz for timezone handling
    try:
        import pytz
    except ImportError:
        print_manager.print_status("⚠️ pytz not available, falling back to UTC")
        markers_timezone = "UTC"
    
    # Convert to specified timezone
    if markers_timezone == "UTC":
        start_time = start_time_py
        end_time = end_time_py
        timezone_obj = pytz.UTC
        timezone_name = "UTC"
    else:
        try:
            # Get timezone object
            timezone_obj = pytz.timezone(markers_timezone)
            
            # Convert UTC times to target timezone
            start_time = start_time_py.replace(tzinfo=pytz.UTC).astimezone(timezone_obj).replace(tzinfo=None)
            end_time = end_time_py.replace(tzinfo=pytz.UTC).astimezone(timezone_obj).replace(tzinfo=None)
            timezone_name = markers_timezone
        except pytz.exceptions.UnknownTimeZoneError:
            print_manager.print_status(f"⚠️ Unknown timezone '{markers_timezone}', falling back to UTC")
            start_time = start_time_py
            end_time = end_time_py
            timezone_obj = pytz.UTC
            timezone_name = "UTC"
            markers_timezone = "UTC"
    
    # Print the time range
    print_manager.print_marker(f"Marker file time range: {start_time.strftime('%Y-%m-%d %H:%M:%S')} to {end_time.strftime('%Y-%m-%d %H:%M:%S')} {timezone_name}")
    
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
            
            # Get timezone abbreviation for display
            if markers_timezone == "UTC":
                tz_abbrev = "UTC"
            else:
                try:
                    # Get timezone abbreviation (e.g., "HST", "AKDT")
                    tz_obj = pytz.timezone(markers_timezone)
                    tz_abbrev = current_time.replace(tzinfo=tz_obj).strftime('%Z')
                except:
                    tz_abbrev = markers_timezone.split('/')[-1].upper()  # Fallback
            
            if use_am_pm:
                formatted_time = current_time.strftime(f'%m/%d %I:%M %p') + f" {tz_abbrev}"
            else:
                formatted_time = current_time.strftime(f'%m/%d %H:%M') + f" {tz_abbrev}"
            
            # Calculate sample position
            # Convert marker time back to UTC for sample calculation
            if markers_timezone == "UTC":
                current_time_utc = current_time
            else:
                # Convert local time back to UTC - ensure timezone-naive result
                try:
                    # Localize the naive datetime to the target timezone
                    current_time_with_tz = timezone_obj.localize(current_time)
                    # Convert to UTC and remove timezone info for calculation
                    current_time_utc = current_time_with_tz.astimezone(pytz.UTC).replace(tzinfo=None)
                except (AttributeError, ValueError) as e:
                    # Fallback: assume current_time is already UTC
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
    
    timezone_str = timezone_name
        
    print_manager.print_file(f"✅ Generated marker file: {marker_filename} with {timezone_str} markers")
    print_manager.print_marker(f"Created {marker_count} markers from {start_time.strftime('%I:%M %p')} to {end_time.strftime('%I:%M %p')}")
    
    return marker_filename

def create_marker_file(marker_filename, start_time, end_time, marker_interval_hours=1, use_am_pm=True):
    """
    Create a marker file directly from start and end times
    
    Args:
        marker_filename (str): Output marker file path
        start_time (datetime): Start time
        end_time (datetime): End time
        marker_interval_hours (float): Interval between markers in hours
        use_am_pm (bool): Whether to use AM/PM format instead of 24h
        
    Returns:
        str: Path to the created marker file
    """
    # Ensure the directory exists
    os.makedirs(os.path.dirname(marker_filename), exist_ok=True)
    
    # Calculate duration in seconds
    duration = (end_time - start_time).total_seconds()
    
    # Calculate sample rate (1 sample per second for standalone marker files)
    sample_rate = 1.0  # 1 Hz for standalone markers
    
    # Write the marker file
    with open(marker_filename, 'w') as f:
        # Write header lines
        f.write("Marker file version: 1\n")
        f.write("Time format: Seconds\n")
        
        # Set up start time as current marker time
        current_time = start_time
        
        # Write markers at the specified interval
        marker_count = 0
        while current_time <= end_time:
            if use_am_pm:
                formatted_time = current_time.strftime('%m/%d %I:%M %p')
            else:
                formatted_time = current_time.strftime('%m/%d %H:%M')
            
            # Calculate seconds from start
            seconds_from_start = (current_time - start_time).total_seconds()
            
            # Write the marker
            f.write(f"{formatted_time}\t{seconds_from_start:.1f}\n")
            marker_count += 1
            
            # Move to next marker time
            current_time += timedelta(hours=marker_interval_hours)
        
        # Write end marker if needed
        if abs((current_time - timedelta(hours=marker_interval_hours) - end_time).total_seconds()) > 60:
            if use_am_pm:
                formatted_end_time = end_time.strftime('%m/%d %I:%M %p')
            else:
                formatted_end_time = end_time.strftime('%m/%d %H:%M')
                
            seconds_to_end = duration
            f.write(f"{formatted_end_time}\t{seconds_to_end:.1f}\n")
            marker_count += 1
    
    print_manager.print_file(f"✅ Generated standalone marker file: {marker_filename}")
    print_manager.print_marker(f"Created {marker_count} markers spanning {duration/3600:.2f} hours")
    
    return marker_filename 