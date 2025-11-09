#!/usr/bin/env python3
"""
Simulation and testing for progressive chunk batching logic.

Tests the following rules:
1. First 60 minutes: MUST use 10m chunks
2. After 60 minutes: Can upgrade to 1h chunks (if hour-aligned)
3. After using 1h: Can upgrade to 6h chunks (if 6h-aligned)
4. Batching: 1 alone → 2 parallel → 3 parallel → 4 parallel...
5. 6h chunks CAP at 4 parallel
6. Reset batch size on chunk type change
"""

import random
from datetime import datetime, timedelta
from typing import List, Dict, Tuple
from dataclasses import dataclass
from collections import Counter


@dataclass
class Chunk:
    """Represents a chunk with its metadata"""
    type: str  # '10m', '1h', '6h'
    start: datetime
    end: datetime
    duration_minutes: int
    
    def __repr__(self):
        return f"{self.type}[{self.start.strftime('%H:%M')}]"


@dataclass
class Batch:
    """Represents a batch of chunks to download in parallel"""
    chunks: List[Chunk]
    batch_num: int
    
    @property
    def type(self):
        return self.chunks[0].type if self.chunks else None
    
    @property
    def size(self):
        return len(self.chunks)
    
    def __repr__(self):
        if self.size == 1:
            return f"Batch {self.batch_num}: 1×{self.type} alone"
        else:
            return f"Batch {self.batch_num}: {self.size}×{self.type} parallel"


def round_to_10m(dt: datetime) -> datetime:
    """Round datetime down to nearest 10-minute boundary"""
    minute = (dt.minute // 10) * 10
    return dt.replace(minute=minute, second=0, microsecond=0)


def is_hour_aligned(dt: datetime) -> bool:
    """Check if datetime is aligned to hour boundary"""
    return dt.minute == 0 and dt.second == 0


def is_6h_aligned(dt: datetime) -> bool:
    """Check if datetime is aligned to 6-hour boundary (00:00, 06:00, 12:00, 18:00)"""
    return dt.hour % 6 == 0 and dt.minute == 0 and dt.second == 0


def calculate_progressive_chunks(start_time: datetime, end_time: datetime) -> List[Chunk]:
    """
    Calculate which chunks to use for a given time range.
    
    Rules:
    - First 60 minutes: MUST use 10m chunks
    - After 60 minutes: Can upgrade to 1h (if hour-aligned)
    - After using 1h: Can upgrade to 6h (if 6h-aligned)
    - Always use the LARGEST chunk available at each quantization boundary
    """
    chunks = []
    current_time = round_to_10m(start_time)
    minutes_elapsed = 0
    has_used_1h = False  # Track if we've actually USED any 1h chunks
    
    while current_time < end_time:
        remaining_minutes = (end_time - current_time).total_seconds() / 60
        
        # First 60 minutes: must be 10m
        if minutes_elapsed < 60:
            chunk_end = current_time + timedelta(minutes=10)
            chunks.append(Chunk('10m', current_time, chunk_end, 10))
            current_time = chunk_end
            minutes_elapsed += 10
            continue
        
        # After 60 minutes: determine LARGEST chunk we can use at this time
        # Check in order: 6h → 1h → 10m
        
        # Can we use a 6h chunk? (must have used 1h first, be at 6h boundary, have enough time)
        if has_used_1h and is_6h_aligned(current_time) and remaining_minutes >= 360:
            chunk_end = current_time + timedelta(hours=6)
            chunks.append(Chunk('6h', current_time, chunk_end, 360))
            current_time = chunk_end
            minutes_elapsed += 360
        
        # Can we use a 1h chunk? (at hour boundary, have enough time)
        elif is_hour_aligned(current_time) and remaining_minutes >= 60:
            chunk_end = current_time + timedelta(hours=1)
            chunks.append(Chunk('1h', current_time, chunk_end, 60))
            current_time = chunk_end
            minutes_elapsed += 60
            has_used_1h = True  # Mark that we've used a 1h chunk
        
        # Use 10m chunk
        else:
            chunk_end = current_time + timedelta(minutes=10)
            chunks.append(Chunk('10m', current_time, chunk_end, 10))
            current_time = chunk_end
            minutes_elapsed += 10
    
    return chunks


def create_download_batches(chunks: List[Chunk]) -> List[Batch]:
    """
    Create batches for progressive downloading.
    
    Rules:
    - Start each new chunk type with batch size 1
    - Increment: 1 → 2 → 3 → 4 → 5...
    - CAP 6h chunks at 4 parallel
    - Reset to 1 when chunk type changes
    """
    if not chunks:
        return []
    
    batches = []
    current_type = None
    batch_size = 1
    remaining_in_type = []
    batch_num = 1
    
    for chunk in chunks:
        # Type change → flush and reset
        if chunk.type != current_type:
            # Flush any remaining from previous type
            if remaining_in_type:
                batches.append(Batch(remaining_in_type, batch_num))
                batch_num += 1
                remaining_in_type = []
            
            current_type = chunk.type
            batch_size = 1  # RESET to 1
        
        remaining_in_type.append(chunk)
        
        # When we have enough for current batch size, flush it
        if len(remaining_in_type) == batch_size:
            batches.append(Batch(remaining_in_type, batch_num))
            batch_num += 1
            remaining_in_type = []
            
            # Increment batch size for next batch (with cap for 6h)
            if current_type == '6h':
                batch_size = min(batch_size + 1, 4)  # CAP at 4 for 6h chunks
            else:
                batch_size += 1  # No cap for 10m and 1h
    
    # Flush any remaining chunks
    if remaining_in_type:
        batches.append(Batch(remaining_in_type, batch_num))
    
    return batches


def validate_chunks(chunks: List[Chunk], start_time: datetime, end_time: datetime) -> Tuple[bool, List[str]]:
    """
    Validate that chunks ONLY request files that EXIST in R2 storage.
    
    Files only exist at quantized boundaries:
    - 10m: every 10 minutes (00:00, 00:10, 00:20, ..., 23:50)
    - 1h:  every hour (00:00, 01:00, 02:00, ..., 23:00)
    - 6h:  ONLY at 00:00, 06:00, 12:00, 18:00
    
    Requesting a file at any other time will FAIL because the file doesn't exist!
    """
    errors = []
    
    if not chunks:
        errors.append("No chunks generated")
        return False, errors
    
    # Check chunks are in order and contiguous
    for i in range(len(chunks) - 1):
        if chunks[i].end != chunks[i + 1].start:
            errors.append(f"Gap between chunk {i} and {i+1}")
    
    # CRITICAL: Every chunk MUST be at its quantization boundary or the file doesn't exist!
    for i, chunk in enumerate(chunks):
        if chunk.type == '10m':
            # 10m chunks exist every 10 minutes
            if chunk.start.minute % 10 != 0 or chunk.start.second != 0:
                errors.append(
                    f"❌ FATAL: 10m chunk {i} at {chunk.start} is NOT on 10-minute boundary! "
                    f"File doesn't exist in R2!"
                )
        
        elif chunk.type == '1h':
            # 1h chunks exist every hour (at :00)
            if chunk.start.minute != 0 or chunk.start.second != 0:
                errors.append(
                    f"❌ FATAL: 1h chunk {i} at {chunk.start} is NOT on hour boundary! "
                    f"File doesn't exist in R2!"
                )
        
        elif chunk.type == '6h':
            # 6h chunks ONLY exist at 00:00, 06:00, 12:00, 18:00
            if chunk.start.hour not in [0, 6, 12, 18] or chunk.start.minute != 0 or chunk.start.second != 0:
                errors.append(
                    f"❌ FATAL: 6h chunk {i} at {chunk.start} is NOT on 6-hour boundary (00/06/12/18)! "
                    f"File doesn't exist in R2!"
                )
    
    # Check first 60 minutes are all 10m (startup rule)
    minutes_elapsed = 0
    for i, chunk in enumerate(chunks):
        if minutes_elapsed < 60 and chunk.type != '10m':
            errors.append(f"First 60min rule: Chunk {i} at {minutes_elapsed}min is {chunk.type}, should be 10m")
        minutes_elapsed += chunk.duration_minutes
        if minutes_elapsed >= 60:
            break
    
    # Check we use 1h before 6h (progressive upgrade rule)
    seen_1h = False
    for i, chunk in enumerate(chunks):
        if chunk.type == '6h' and not seen_1h:
            errors.append(f"Progressive rule: 6h chunk {i} appears before any 1h chunks")
        if chunk.type == '1h':
            seen_1h = True
    
    # VALIDATE: We should use the LARGEST possible chunk at each quantization boundary
    # (This ensures we're being efficient AND respecting boundaries)
    minutes_from_start = 0
    has_seen_1h = False
    
    for i, chunk in enumerate(chunks):
        remaining_time = end_time - chunk.start
        remaining_minutes = remaining_time.total_seconds() / 60
        
        # After first 60 minutes, check if we COULD use larger chunks at boundaries
        if minutes_from_start >= 60:
            # At a 6h boundary with enough time left?
            if has_seen_1h and is_6h_aligned(chunk.start) and remaining_minutes >= 360:
                if chunk.type != '6h':
                    errors.append(
                        f"Efficiency: Chunk {i} at {chunk.start.strftime('%H:%M')} should use 6h file "
                        f"(at 6h boundary, {remaining_minutes:.0f}min left) but uses {chunk.type}"
                    )
            # At an hour boundary with enough time left?
            elif is_hour_aligned(chunk.start) and remaining_minutes >= 60:
                if chunk.type == '10m':
                    errors.append(
                        f"Efficiency: Chunk {i} at {chunk.start.strftime('%H:%M')} should use 1h file "
                        f"(at hour boundary, {remaining_minutes:.0f}min left) but uses {chunk.type}"
                    )
        
        if chunk.type == '1h':
            has_seen_1h = True
        
        minutes_from_start += chunk.duration_minutes
    
    return len(errors) == 0, errors


def validate_batches(batches: List[Batch], chunks: List[Chunk]) -> Tuple[bool, List[str]]:
    """Validate that batches follow the batching rules"""
    errors = []
    
    if not batches:
        return True, []
    
    # Track batch sizes by type
    type_batch_sizes = {}
    
    for batch in batches:
        chunk_type = batch.type
        
        # Initialize or check batch size progression
        if chunk_type not in type_batch_sizes:
            # First batch of this type should be size 1
            if batch.size != 1:
                errors.append(f"{batch}: First batch of {chunk_type} should be size 1, got {batch.size}")
            type_batch_sizes[chunk_type] = [batch.size]
        else:
            type_batch_sizes[chunk_type].append(batch.size)
    
    # Validate batch size progression for each type
    for chunk_type, sizes in type_batch_sizes.items():
        for i in range(len(sizes) - 1):
            expected_next = sizes[i] + 1
            if chunk_type == '6h':
                expected_next = min(expected_next, 4)  # Cap at 4
            
            actual_next = sizes[i + 1]
            if actual_next > expected_next:
                errors.append(f"{chunk_type}: Batch size jumped from {sizes[i]} to {actual_next}, expected {expected_next}")
            
            # Check cap for 6h
            if chunk_type == '6h' and actual_next > 4:
                errors.append(f"{chunk_type}: Batch size {actual_next} exceeds cap of 4")
    
    return len(errors) == 0, errors


def analyze_efficiency(chunks: List[Chunk], batches: List[Batch]) -> Dict:
    """Analyze the efficiency of the chunk selection and batching"""
    total_chunks = len(chunks)
    total_batches = len(batches)
    
    chunk_counts = Counter(c.type for c in chunks)
    
    # Time to first chunk ready (first batch completion)
    time_to_first = batches[0].size if batches else 0
    
    # Average batch size (excluding first batch for startup metric)
    avg_batch_size = sum(b.size for b in batches[1:]) / len(batches[1:]) if len(batches) > 1 else 0
    
    # Chunk size efficiency (% of time covered by large chunks)
    total_minutes = sum(c.duration_minutes for c in chunks)
    large_chunk_minutes = sum(c.duration_minutes for c in chunks if c.type in ['1h', '6h'])
    large_chunk_pct = (large_chunk_minutes / total_minutes * 100) if total_minutes > 0 else 0
    
    return {
        'total_chunks': total_chunks,
        'total_batches': total_batches,
        'chunk_counts': dict(chunk_counts),
        'time_to_first': time_to_first,
        'avg_batch_size': avg_batch_size,
        'large_chunk_pct': large_chunk_pct,
        'sequential_downloads': total_batches,  # Lower is better
    }


def print_test_case(test_num: int, start_time: datetime, duration_minutes: int):
    """Print a formatted test case with results"""
    print(f"\n{'='*80}")
    print(f"TEST CASE #{test_num}")
    print(f"{'='*80}")
    
    end_time = start_time + timedelta(minutes=duration_minutes)
    
    print(f"Start:    {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"End:      {end_time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Duration: {duration_minutes} minutes ({duration_minutes/60:.1f} hours)")
    
    # Calculate chunks
    chunks = calculate_progressive_chunks(start_time, end_time)
    
    # Validate chunks
    chunks_valid, chunk_errors = validate_chunks(chunks, start_time, end_time)
    
    # Create batches
    batches = create_download_batches(chunks)
    
    # Validate batches
    batches_valid, batch_errors = validate_batches(batches, chunks)
    
    # Print chunk summary
    print(f"\n📋 CHUNKS: {len(chunks)} total")
    chunk_counts = Counter(c.type for c in chunks)
    breakdown = ', '.join(f"{count}×{ctype}" for ctype, count in sorted(chunk_counts.items()))
    print(f"   Breakdown: {breakdown}")
    
    # Show first few chunks
    print(f"   First chunks: {' → '.join(str(c) for c in chunks[:10])}")
    if len(chunks) > 10:
        print(f"   ... {len(chunks) - 10} more chunks ...")
        print(f"   Last chunks: {' → '.join(str(c) for c in chunks[-5:])}")
    
    # Print batch plan
    print(f"\n🚀 DOWNLOAD PLAN: {len(batches)} batches")
    batch_plan = ' → '.join(f"{b.size}×{b.type}" for b in batches)
    print(f"   Pattern: {batch_plan}")
    
    # Show detailed batches for shorter durations
    if len(batches) <= 15:
        for batch in batches:
            chunk_list = ', '.join(str(c) for c in batch.chunks)
            print(f"   {batch}: {chunk_list}")
    else:
        # Show first and last few batches
        for batch in batches[:5]:
            chunk_list = ', '.join(str(c) for c in batch.chunks)
            print(f"   {batch}: {chunk_list}")
        print(f"   ... {len(batches) - 10} more batches ...")
        for batch in batches[-5:]:
            chunk_list = ', '.join(str(c) for c in batch.chunks)
            print(f"   {batch}: {chunk_list}")
    
    # Print efficiency metrics
    efficiency = analyze_efficiency(chunks, batches)
    print(f"\n📊 EFFICIENCY METRICS:")
    print(f"   Time to first chunk: {efficiency['time_to_first']} batch(es)")
    print(f"   Sequential downloads: {efficiency['sequential_downloads']} batches")
    print(f"   Avg batch size (excl. first): {efficiency['avg_batch_size']:.2f}")
    print(f"   Large chunk coverage: {efficiency['large_chunk_pct']:.1f}%")
    
    # Print validation results
    print(f"\n✅ VALIDATION:")
    if chunks_valid:
        print(f"   ✓ Chunks: PASS")
    else:
        print(f"   ✗ Chunks: FAIL")
        for error in chunk_errors:
            print(f"      - {error}")
    
    if batches_valid:
        print(f"   ✓ Batches: PASS")
    else:
        print(f"   ✗ Batches: FAIL")
        for error in batch_errors:
            print(f"      - {error}")
    
    overall = "PASS ✅" if chunks_valid and batches_valid else "FAIL ❌"
    print(f"\n   Overall: {overall}")
    
    return chunks_valid and batches_valid


def generate_random_start_time() -> datetime:
    """Generate a random start time in the past month"""
    now = datetime.utcnow()
    days_ago = random.randint(0, 30)
    hour = random.randint(0, 23)
    minute = random.randint(0, 5) * 10  # 0, 10, 20, 30, 40, 50
    
    return now.replace(hour=hour, minute=minute, second=0, microsecond=0) - timedelta(days=days_ago)


def run_simulation(num_tests: int = 10):
    """Run simulation with random test cases"""
    print("="*80)
    print("PROGRESSIVE CHUNK BATCHING SIMULATION")
    print("="*80)
    
    # Test durations to try
    durations = [30, 60, 120, 240, 360, 720, 1440, 2880]  # 30m to 48h
    
    all_passed = True
    passed_count = 0
    failed_count = 0
    
    for i in range(num_tests):
        start_time = generate_random_start_time()
        duration = random.choice(durations)
        
        passed = print_test_case(i + 1, start_time, duration)
        
        if passed:
            passed_count += 1
        else:
            failed_count += 1
            all_passed = False
    
    # Print summary
    print(f"\n{'='*80}")
    print(f"SIMULATION SUMMARY")
    print(f"{'='*80}")
    print(f"Total tests: {num_tests}")
    print(f"Passed: {passed_count} ✅")
    print(f"Failed: {failed_count} ❌")
    
    if all_passed:
        print(f"\n🎉 ALL TESTS PASSED!")
    else:
        print(f"\n⚠️  SOME TESTS FAILED")
    
    return all_passed


def run_specific_examples():
    """Run specific test cases mentioned in the spec"""
    print("="*80)
    print("SPECIFIC TEST CASES FROM SPEC")
    print("="*80)
    
    # Use a consistent base time
    base = datetime(2025, 11, 9, 0, 0, 0)
    
    tests = [
        ("1 hour (6×10m)", base, 60),
        ("2 hours (6×10m + 1×1h)", base, 120),
        ("12 hours (6×10m + 5×1h + 1×6h)", base, 720),
        ("48 hours (6×10m + 5×1h + 7×6h)", base, 2880),
    ]
    
    all_passed = True
    for i, (name, start, duration) in enumerate(tests, 1):
        print(f"\nSPECIFIC TEST: {name}")
        passed = print_test_case(i, start, duration)
        if not passed:
            all_passed = False
    
    return all_passed


if __name__ == "__main__":
    import sys
    
    # Run specific examples first
    print("\n" + "="*80)
    print("PART 1: SPECIFIC EXAMPLES")
    print("="*80)
    specific_passed = run_specific_examples()
    
    # Run random simulation
    print("\n\n" + "="*80)
    print("PART 2: RANDOM SIMULATION")
    print("="*80)
    
    num_tests = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    simulation_passed = run_simulation(num_tests)
    
    # Final result
    print("\n" + "="*80)
    print("FINAL RESULT")
    print("="*80)
    
    if specific_passed and simulation_passed:
        print("✅ ALL TESTS PASSED")
        sys.exit(0)
    else:
        print("❌ SOME TESTS FAILED")
        sys.exit(1)

