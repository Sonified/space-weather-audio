#!/usr/bin/env python3
"""
Print Manager for Spurr Audification
Controls the verbosity and types of information displayed in the notebook/console
"""

class PrintManager:
    """
    Singleton class to manage print verbosity across the application
    Controls what types of information are displayed
    """
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(PrintManager, cls).__new__(cls)
            # Initialize default settings
            cls._instance.show_times = True         # Show timestamps (UTC, Alaska)
            cls._instance.show_files = True         # Show file paths and file operations
            cls._instance.show_buttons = True       # Show UI buttons
            cls._instance.show_marker_summary = True  # Show marker file summary
            cls._instance.show_plots = True         # Show plot information
            cls._instance.show_data_info = False    # Show detailed data info (points, min/max)
            cls._instance.show_api_requests = False  # Show API request details
            cls._instance.show_all_markers = False  # Show all markers (vs just first/last few)
            cls._instance.show_status = True        # Show important status messages
        return cls._instance
    
    def print_time(self, message):
        """Print time-related information"""
        if self.show_times:
            print(message)
    
    def print_file(self, message):
        """Print file operation information"""
        if self.show_files:
            print(message)
    
    def print_data(self, message):
        """Print data-related information"""
        if self.show_data_info:
            print(message)
    
    def print_api(self, message):
        """Print API request information"""
        if self.show_api_requests:
            print(message)
    
    def print_marker(self, message):
        """Print marker-related information"""
        if self.show_marker_summary:
            print(message)
    
    def print_all_markers(self, message):
        """Print detailed marker information"""
        if self.show_all_markers:
            print(message)
    
    def print_status(self, message):
        """Always print this important status message regardless of most settings"""
        if self.show_status:
            print(message)
    
    # Add alias for backward compatibility
    def print_always(self, message):
        """Alias for print_status for backward compatibility"""
        self.print_status(message)
    
    def display_settings(self):
        """Display current print manager settings"""
        print("\n=== Print Manager Settings ===")
        print(f"print_manager.show_times = {self.show_times}")
        print(f"print_manager.show_files = {self.show_files}")
        print(f"print_manager.show_buttons = {self.show_buttons}")
        print(f"print_manager.show_marker_summary = {self.show_marker_summary}")
        print(f"print_manager.show_plots = {self.show_plots}")
        print(f"print_manager.show_data_info = {self.show_data_info}")
        print(f"print_manager.show_api_requests = {self.show_api_requests}")
        print(f"print_manager.show_all_markers = {self.show_all_markers}")
        print(f"print_manager.show_status = {self.show_status}")
        print("\nTo change settings, use: print_manager.show_XXX = True/False")
    
    def toggle(self, setting_name):
        """Toggle a setting on/off"""
        if hasattr(self, setting_name):
            setattr(self, setting_name, not getattr(self, setting_name))
            print(f"{setting_name} is now {'enabled' if getattr(self, setting_name) else 'disabled'}")
        else:
            print(f"Unknown setting: {setting_name}")

# Create a singleton instance
print_manager = PrintManager()

if __name__ == "__main__":
    # Example usage
    print_manager.display_settings()
    print_manager.print_time("This is a time message")
    print_manager.print_data("This is a data message (hidden by default)")
    
    # Toggle a setting
    print_manager.toggle("show_data_info")
    print_manager.print_data("This data message is now visible") 