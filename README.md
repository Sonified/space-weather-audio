# Seismic Audification Tool

A tool for converting seismic data from Mt. Spurr volcano into audio for listening and analysis.

## Overview

This project fetches seismic data from IRIS FDSN Web Service, processes it, and converts it to audio files (audification). It also generates plots for visualization and marker files for use with audio editing software.

## Features

- Fetch seismic data from IRIS for specific time windows
- Process and normalize seismic data
- Convert seismic data to audio (WAV format)
- Generate visualizations of the data
- Create marker files for audio alignment
- Support for different stations and channels

## Installation

1. Clone this repository
2. Install dependencies:
   ```
   pip install -r requirements.txt
   ```

## Usage

Run the main script to generate audio from seismic data:

```
python main.py --days 1 --station AV.SPBG --channel BHZ
```

### Command-line Arguments

- `--days`: Number of days of data to process (1 or 2, default: 1)
- `--station`: Seismic station code (default: 'AV.SPBG')
- `--channel`: Channel code (default: 'BHZ')

## Output Files

The tool generates the following files in the `output` directory:

- WAV audio file of the seismic data
- PNG plot of the seismic data
- TXT marker file with timestamps
- MSEED file with the raw seismic data

## Project Structure

- `main.py`: Main execution script
- `seismic_time.py`: Utilities for time window calculations
- `data_fetcher.py`: Functions for fetching seismic data
- `audio_utils.py`: Functions for audio conversion and marker creation
- `plot_utils.py`: Functions for data visualization

## Notes

- By default, the tool fetches data from the previous day (midnight to midnight in Alaska time)
- For audification, seismic data is normalized to the range [-1, 1]
- Markers are placed at 6-hour intervals for easier navigation 