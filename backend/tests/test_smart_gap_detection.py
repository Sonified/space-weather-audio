#!/usr/bin/env python3
"""
Test the smart gap detection logic using actual collection timestamps.

Tests the is_window_being_collected() function which determines whether
a data window should be excluded from gap detection based on when the
last collection completed.
"""

from datetime import datetime, timezone, timedelta
import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent))
from collector_loop import is_window_being_collected


def test_window_before_completion():
    """
    SCENARIO: Collection finished at 12:03:30
    Window ended at 12:00:00 (ended BEFORE completion)
    EXPECTED: Should check this window (return False)
    """
    print("\n" + "="*80)
    print("TEST 1: Window ended BEFORE last collection completed")
    print("="*80)
    
    last_run_completed = "2025-11-05T12:03:30Z"
    window_end = datetime(2025, 11, 5, 12, 0, 0, tzinfo=timezone.utc)  # 12:00:00
    
    result = is_window_being_collected(window_end, last_run_completed)
    
    print(f"Last collection completed: {last_run_completed}")
    print(f"Window ended at:           {window_end.isoformat()}")
    print(f"Should be checked?         {not result}")
    print(f"Result (exclude?):         {result}")
    
    assert result == False, "Window that ended before completion should be checked"
    print("✅ PASSED: Window is correctly marked for checking")
    

def test_window_after_completion():
    """
    SCENARIO: Collection finished at 12:03:30
    Window ended at 12:10:00 (ended AFTER completion)
    EXPECTED: Should exclude this window (return True)
    """
    print("\n" + "="*80)
    print("TEST 2: Window ended AFTER last collection completed")
    print("="*80)
    
    last_run_completed = "2025-11-05T12:03:30Z"
    window_end = datetime(2025, 11, 5, 12, 10, 0, tzinfo=timezone.utc)  # 12:10:00
    
    result = is_window_being_collected(window_end, last_run_completed)
    
    print(f"Last collection completed: {last_run_completed}")
    print(f"Window ended at:           {window_end.isoformat()}")
    print(f"Should be excluded?        {result}")
    print(f"Result (exclude?):         {result}")
    
    assert result == True, "Window that ended after completion should be excluded"
    print("✅ PASSED: Window is correctly excluded from checking")


def test_window_exactly_at_completion():
    """
    SCENARIO: Collection finished at 12:00:00
    Window ended at 12:00:00 (exact same time)
    EXPECTED: Should exclude (>= logic means exclude if equal)
    """
    print("\n" + "="*80)
    print("TEST 3: Window ended EXACTLY at completion time")
    print("="*80)
    
    last_run_completed = "2025-11-05T12:00:00Z"
    window_end = datetime(2025, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    
    result = is_window_being_collected(window_end, last_run_completed)
    
    print(f"Last collection completed: {last_run_completed}")
    print(f"Window ended at:           {window_end.isoformat()}")
    print(f"Should be excluded?        {result}")
    print(f"Result (exclude?):         {result}")
    
    assert result == False, "Window that ended exactly at completion should be checked (not >)"
    print("✅ PASSED: Exact match is correctly handled")


def test_no_completion_yet():
    """
    SCENARIO: First run, no collections have completed yet
    EXPECTED: Should exclude anything within last 10 minutes
    """
    print("\n" + "="*80)
    print("TEST 4: No collections completed yet (first run)")
    print("="*80)
    
    now = datetime.now(timezone.utc)
    
    # Window ended 15 minutes ago (should check)
    old_window = now - timedelta(minutes=15)
    result_old = is_window_being_collected(old_window, None)
    
    # Window ended 5 minutes ago (should exclude)
    recent_window = now - timedelta(minutes=5)
    result_recent = is_window_being_collected(recent_window, None)
    
    print(f"Current time:              {now.isoformat()}")
    print(f"\nOld window (15 min ago):   {old_window.isoformat()}")
    print(f"  Should be excluded?      {result_old}")
    
    print(f"\nRecent window (5 min ago): {recent_window.isoformat()}")
    print(f"  Should be excluded?      {result_recent}")
    
    assert result_old == False, "Window from 15 minutes ago should be checked"
    assert result_recent == True, "Window from 5 minutes ago should be excluded"
    print("✅ PASSED: First-run logic correctly uses 10-minute buffer")


def test_realistic_collection_scenario():
    """
    SCENARIO: Realistic 10-minute collection cycle at :02
    Collection started at 12:02:00, completed at 12:03:30
    Check multiple windows around this time
    """
    print("\n" + "="*80)
    print("TEST 5: Realistic 10-minute collection cycle")
    print("="*80)
    
    last_run_completed = "2025-11-05T12:03:30Z"
    
    test_cases = [
        # (window_end_time, should_exclude, description)
        (datetime(2025, 11, 5, 11, 50, 0, tzinfo=timezone.utc), False, "11:40-11:50 window"),
        (datetime(2025, 11, 5, 12, 0, 0, tzinfo=timezone.utc), False, "11:50-12:00 window"),
        (datetime(2025, 11, 5, 12, 10, 0, tzinfo=timezone.utc), True, "12:00-12:10 window (being collected)"),
        (datetime(2025, 11, 5, 12, 20, 0, tzinfo=timezone.utc), True, "12:10-12:20 window (future)"),
        (datetime(2025, 11, 5, 13, 0, 0, tzinfo=timezone.utc), True, "12:00-13:00 1h window (future)"),
    ]
    
    print(f"Collection completed at: {last_run_completed}")
    print(f"\nChecking windows:\n")
    
    all_passed = True
    for window_end, expected_exclude, description in test_cases:
        result = is_window_being_collected(window_end, last_run_completed)
        status = "✅" if result == expected_exclude else "❌"
        
        print(f"{status} {description}")
        print(f"   Ended: {window_end.isoformat()}")
        print(f"   Expected exclude: {expected_exclude}, Got: {result}")
        
        if result != expected_exclude:
            all_passed = False
            print(f"   ⚠️  MISMATCH!")
        print()
    
    assert all_passed, "Some test cases failed"
    print("✅ PASSED: All realistic scenarios handled correctly")


def test_parse_error_handling():
    """
    SCENARIO: Invalid timestamp format
    EXPECTED: Should be conservative and exclude the window
    """
    print("\n" + "="*80)
    print("TEST 6: Parse error handling")
    print("="*80)
    
    invalid_timestamp = "not-a-valid-timestamp"
    window_end = datetime(2025, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    
    result = is_window_being_collected(window_end, invalid_timestamp)
    
    print(f"Invalid timestamp:   {invalid_timestamp}")
    print(f"Window ended at:     {window_end.isoformat()}")
    print(f"Result (exclude?):   {result}")
    
    assert result == True, "Parse errors should be conservative (exclude)"
    print("✅ PASSED: Parse errors handled conservatively")


def test_multi_day_scenario():
    """
    SCENARIO: Collection completed yesterday, checking today's windows
    """
    print("\n" + "="*80)
    print("TEST 7: Multi-day scenario")
    print("="*80)
    
    # Collection finished yesterday at 23:55
    last_run_completed = "2025-11-04T23:55:00Z"
    
    test_cases = [
        # Yesterday's windows (should all be checked)
        (datetime(2025, 11, 4, 23, 50, 0, tzinfo=timezone.utc), False, "Yesterday 23:40-23:50"),
        (datetime(2025, 11, 5, 0, 0, 0, tzinfo=timezone.utc), True, "Today 23:50-00:00 (after completion)"),
        (datetime(2025, 11, 5, 0, 10, 0, tzinfo=timezone.utc), True, "Today 00:00-00:10 (after completion)"),
    ]
    
    print(f"Collection completed: {last_run_completed}")
    print(f"\nChecking windows:\n")
    
    all_passed = True
    for window_end, expected_exclude, description in test_cases:
        result = is_window_being_collected(window_end, last_run_completed)
        status = "✅" if result == expected_exclude else "❌"
        
        print(f"{status} {description}")
        print(f"   Ended: {window_end.isoformat()}")
        print(f"   Expected exclude: {expected_exclude}, Got: {result}")
        
        if result != expected_exclude:
            all_passed = False
            print(f"   ⚠️  MISMATCH!")
        print()
    
    assert all_passed, "Multi-day scenario failed"
    print("✅ PASSED: Multi-day scenarios handled correctly")


def run_all_tests():
    """Run all test cases"""
    print("\n" + "🧪 " + "="*76)
    print("SMART GAP DETECTION TESTS")
    print("Testing: is_window_being_collected() logic")
    print("="*78)
    
    tests = [
        test_window_before_completion,
        test_window_after_completion,
        test_window_exactly_at_completion,
        test_no_completion_yet,
        test_realistic_collection_scenario,
        test_parse_error_handling,
        test_multi_day_scenario,
    ]
    
    passed = 0
    failed = 0
    
    for test_func in tests:
        try:
            test_func()
            passed += 1
        except AssertionError as e:
            failed += 1
            print(f"\n❌ TEST FAILED: {test_func.__name__}")
            print(f"   {str(e)}")
        except Exception as e:
            failed += 1
            print(f"\n💥 TEST ERROR: {test_func.__name__}")
            print(f"   {str(e)}")
            import traceback
            traceback.print_exc()
    
    print("\n" + "="*80)
    print("SUMMARY")
    print("="*80)
    print(f"Total tests: {len(tests)}")
    print(f"Passed:      {passed} ✅")
    print(f"Failed:      {failed} ❌")
    
    if failed == 0:
        print("\n🎉 ALL TESTS PASSED! The smart gap detection logic is working correctly.")
    else:
        print(f"\n⚠️  {failed} test(s) failed. Review the output above.")
        sys.exit(1)


if __name__ == "__main__":
    run_all_tests()

