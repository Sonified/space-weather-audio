# TODO

- Implement a new buffering system for the AudioWorklet (it's used a circular buffer thus far but it's finicky, and linear will be ideal for our purposes)

- Set up a function that can back-fill 24 hours of data for a given station (in the correct format)

- Implement an intelligent visual and auditory normalization such that extreme outliers won't cause the entire signal for a day to be very quiet

- Add the y-axis and x-axis ticks for tracking frequency and time

- Implement the system for marking regions of interest

- Build the flow for participants arriving on the page

- Test the whole pipeline with the Qualtrics back end

