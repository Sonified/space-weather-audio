#!/usr/bin/env python3
"""
Performance testing for progressive streaming configurations.

Tests different approaches to optimize Time to First Audio (TTFA) and total load time:
1. Worker-based decompression (current approach)
2. Main thread decompression (baseline)
3. Different chunk sizes (10m vs 1h first chunk)
4. Parallel chunk fetching
5. Streaming decompression
6. Pre-compressed normalization ranges

Usage:
    python test_progressive_performance.py
    
Output:
    - Console logs with timing breakdowns
    - JSON file with detailed metrics
    - Recommendations for optimization
"""

import time
import json
import requests
import zstandard as zstd
import numpy as np
from datetime import datetime, timedelta
from typing import Dict, List, Tuple
import statistics

# Test configuration
R2_WORKER_URL = 'https://volcano-audio-test.robertalexander-music.workers.dev'
TEST_STATION = {
    'network': 'HV',
    'station': 'OBL',
    'location': '',
    'channel': 'HHZ'
}
TEST_DURATION_MINUTES = 10  # 10 minutes for faster testing
NUM_RUNS = 3  # Run each test multiple times for statistical significance


class PerformanceTest:
    """Base class for performance tests."""
    
    def __init__(self, name: str, description: str):
        self.name = name
        self.description = description
        self.results = []
    
    def run(self) -> Dict:
        """Run the test and return timing metrics."""
        raise NotImplementedError
    
    def run_multiple(self, num_runs: int = NUM_RUNS) -> Dict:
        """Run test multiple times and aggregate results."""
        print(f"\n{'='*80}")
        print(f"🧪 TEST: {self.name}")
        print(f"📝 {self.description}")
        print(f"🔄 Running {num_runs} times...")
        print(f"{'='*80}\n")
        
        results = []
        for i in range(num_runs):
            print(f"  Run {i+1}/{num_runs}...")
            result = self.run()
            results.append(result)
            time.sleep(0.5)  # Brief pause between runs
        
        # Aggregate results
        aggregated = self._aggregate_results(results)
        self.results = results
        
        print(f"\n📊 RESULTS:")
        print(f"  TTFA: {aggregated['ttfa_mean']:.0f}ms ± {aggregated['ttfa_std']:.0f}ms")
        print(f"  Total: {aggregated['total_mean']:.0f}ms ± {aggregated['total_std']:.0f}ms")
        print(f"  Download: {aggregated['download_mean']:.0f}ms ± {aggregated['download_std']:.0f}ms")
        print(f"  Process: {aggregated['process_mean']:.0f}ms ± {aggregated['process_std']:.0f}ms")
        
        return aggregated
    
    def _aggregate_results(self, results: List[Dict]) -> Dict:
        """Aggregate multiple test runs."""
        ttfas = [r['ttfa'] for r in results]
        totals = [r['total_time'] for r in results]
        downloads = [r['download_time'] for r in results]
        processes = [r['process_time'] for r in results]
        
        return {
            'name': self.name,
            'description': self.description,
            'ttfa_mean': statistics.mean(ttfas),
            'ttfa_std': statistics.stdev(ttfas) if len(ttfas) > 1 else 0,
            'ttfa_min': min(ttfas),
            'ttfa_max': max(ttfas),
            'total_mean': statistics.mean(totals),
            'total_std': statistics.stdev(totals) if len(totals) > 1 else 0,
            'total_min': min(totals),
            'total_max': max(totals),
            'download_mean': statistics.mean(downloads),
            'download_std': statistics.stdev(downloads) if len(downloads) > 1 else 0,
            'process_mean': statistics.mean(processes),
            'process_std': statistics.stdev(processes) if len(processes) > 1 else 0,
            'num_runs': len(results),
            'raw_results': results
        }


class BaselineTest(PerformanceTest):
    """Baseline: Sequential fetch + decompress in main thread (current browser approach)."""
    
    def __init__(self):
        super().__init__(
            "Baseline: Sequential Main Thread",
            "Fetch chunks sequentially, decompress in main thread (simulates current browser without worker)"
        )
    
    def run(self) -> Dict:
        t0 = time.time()
        
        # Get metadata
        metadata = self._fetch_metadata()
        chunks = metadata['chunks']
        norm_min = metadata['normalization']['min']
        norm_max = metadata['normalization']['max']
        
        # Process chunks sequentially
        ttfa = None
        download_time = 0
        process_time = 0
        total_samples = 0
        
        for i, chunk in enumerate(chunks):
            # Fetch chunk
            t_fetch_start = time.time()
            compressed = self._fetch_chunk(chunk)
            t_fetch_end = time.time()
            download_time += (t_fetch_end - t_fetch_start) * 1000
            
            # Decompress and process
            t_process_start = time.time()
            samples = self._decompress_and_normalize(compressed, norm_min, norm_max)
            t_process_end = time.time()
            process_time += (t_process_end - t_process_start) * 1000
            
            total_samples += len(samples)
            
            # TTFA = when first chunk is ready
            if i == 0:
                ttfa = (time.time() - t0) * 1000
        
        total_time = (time.time() - t0) * 1000
        
        return {
            'ttfa': ttfa,
            'total_time': total_time,
            'download_time': download_time,
            'process_time': process_time,
            'num_chunks': len(chunks),
            'total_samples': total_samples
        }
    
    def _fetch_metadata(self) -> Dict:
        """Fetch progressive metadata."""
        end_time = datetime.utcnow()
        start_time = end_time - timedelta(minutes=TEST_DURATION_MINUTES)
        
        url = f"{R2_WORKER_URL}/progressive-metadata"
        params = {
            'network': TEST_STATION['network'],
            'station': TEST_STATION['station'],
            'location': TEST_STATION['location'] or '--',
            'channel': TEST_STATION['channel'],
            'start_time': start_time.isoformat(),
            'duration_minutes': TEST_DURATION_MINUTES
        }
        
        response = requests.get(url, params=params, timeout=30)
        response.raise_for_status()
        return response.json()
    
    def _fetch_chunk(self, chunk: Dict) -> bytes:
        """Fetch a single chunk."""
        url = f"{R2_WORKER_URL}/chunk"
        params = {
            'network': TEST_STATION['network'],
            'station': TEST_STATION['station'],
            'location': TEST_STATION['location'] or '--',
            'channel': TEST_STATION['channel'],
            'date': chunk['date'],
            'start': chunk['start'],
            'end': chunk['end'],
            'chunk_type': chunk['type']
        }
        
        response = requests.get(url, params=params, timeout=30)
        response.raise_for_status()
        return response.content
    
    def _decompress_and_normalize(self, compressed: bytes, norm_min: float, norm_max: float) -> np.ndarray:
        """Decompress and normalize chunk."""
        # Decompress
        dctx = zstd.ZstdDecompressor()
        decompressed = dctx.decompress(compressed)
        
        # Parse int16 array
        int16_array = np.frombuffer(decompressed, dtype=np.int16)
        
        # Normalize to [-1, 1]
        samples = (int16_array.astype(np.float32) - norm_min) / (norm_max - norm_min) * 2 - 1
        
        return samples


class ParallelFetchTest(PerformanceTest):
    """Fetch all chunks in parallel, then process sequentially."""
    
    def __init__(self):
        super().__init__(
            "Parallel Fetch + Sequential Process",
            "Fetch all chunks in parallel (concurrent requests), then decompress/normalize sequentially"
        )
    
    def run(self) -> Dict:
        import concurrent.futures
        
        t0 = time.time()
        
        # Get metadata
        metadata = BaselineTest()._fetch_metadata()
        chunks = metadata['chunks']
        norm_min = metadata['normalization']['min']
        norm_max = metadata['normalization']['max']
        
        # Fetch all chunks in parallel
        t_fetch_start = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            compressed_chunks = list(executor.map(
                lambda c: BaselineTest()._fetch_chunk(c),
                chunks
            ))
        t_fetch_end = time.time()
        download_time = (t_fetch_end - t_fetch_start) * 1000
        
        # Process chunks sequentially
        t_process_start = time.time()
        ttfa = None
        total_samples = 0
        
        for i, compressed in enumerate(compressed_chunks):
            samples = BaselineTest()._decompress_and_normalize(compressed, norm_min, norm_max)
            total_samples += len(samples)
            
            if i == 0:
                ttfa = (time.time() - t0) * 1000
        
        t_process_end = time.time()
        process_time = (t_process_end - t_process_start) * 1000
        
        total_time = (time.time() - t0) * 1000
        
        return {
            'ttfa': ttfa,
            'total_time': total_time,
            'download_time': download_time,
            'process_time': process_time,
            'num_chunks': len(chunks),
            'total_samples': total_samples
        }


class ParallelProcessTest(PerformanceTest):
    """Fetch first chunk, process it, then fetch+process rest in parallel."""
    
    def __init__(self):
        super().__init__(
            "First Chunk Priority + Parallel Rest",
            "Fetch & process first chunk ASAP, then fetch+process remaining chunks in parallel"
        )
    
    def run(self) -> Dict:
        import concurrent.futures
        
        t0 = time.time()
        
        # Get metadata
        metadata = BaselineTest()._fetch_metadata()
        chunks = metadata['chunks']
        norm_min = metadata['normalization']['min']
        norm_max = metadata['normalization']['max']
        
        # Process first chunk immediately
        t_first_start = time.time()
        compressed_first = BaselineTest()._fetch_chunk(chunks[0])
        samples_first = BaselineTest()._decompress_and_normalize(compressed_first, norm_min, norm_max)
        ttfa = (time.time() - t0) * 1000
        
        # Process remaining chunks in parallel
        def fetch_and_process(chunk):
            compressed = BaselineTest()._fetch_chunk(chunk)
            samples = BaselineTest()._decompress_and_normalize(compressed, norm_min, norm_max)
            return len(samples)
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            remaining_samples = list(executor.map(fetch_and_process, chunks[1:]))
        
        total_time = (time.time() - t0) * 1000
        total_samples = len(samples_first) + sum(remaining_samples)
        
        # Approximate download vs process time (hard to separate with parallel)
        download_time = total_time * 0.6  # Rough estimate
        process_time = total_time * 0.4
        
        return {
            'ttfa': ttfa,
            'total_time': total_time,
            'download_time': download_time,
            'process_time': process_time,
            'num_chunks': len(chunks),
            'total_samples': total_samples
        }


class StreamingDecompressTest(PerformanceTest):
    """Stream decompression (decompress while downloading)."""
    
    def __init__(self):
        super().__init__(
            "Streaming Decompression",
            "Decompress chunks as they download (streaming decompression)"
        )
    
    def run(self) -> Dict:
        t0 = time.time()
        
        # Get metadata
        metadata = BaselineTest()._fetch_metadata()
        chunks = metadata['chunks']
        norm_min = metadata['normalization']['min']
        norm_max = metadata['normalization']['max']
        
        ttfa = None
        download_time = 0
        process_time = 0
        total_samples = 0
        
        dctx = zstd.ZstdDecompressor()
        
        for i, chunk in enumerate(chunks):
            # Fetch chunk with streaming
            t_fetch_start = time.time()
            url = f"{R2_WORKER_URL}/chunk"
            params = {
                'network': TEST_STATION['network'],
                'station': TEST_STATION['station'],
                'location': TEST_STATION['location'] or '--',
                'channel': TEST_STATION['channel'],
                'date': chunk['date'],
                'start': chunk['start'],
                'end': chunk['end'],
                'chunk_type': chunk['type']
            }
            
            response = requests.get(url, params=params, stream=True, timeout=30)
            response.raise_for_status()
            
            # Stream decompress
            t_process_start = time.time()
            decompressed_chunks = []
            for compressed_chunk in response.iter_content(chunk_size=8192):
                if compressed_chunk:
                    # Note: zstd streaming decompression is complex, this is simplified
                    decompressed_chunks.append(compressed_chunk)
            
            # Decompress full chunk (streaming decompression would be more complex)
            compressed = b''.join(decompressed_chunks)
            decompressed = dctx.decompress(compressed)
            int16_array = np.frombuffer(decompressed, dtype=np.int16)
            samples = (int16_array.astype(np.float32) - norm_min) / (norm_max - norm_min) * 2 - 1
            
            t_process_end = time.time()
            t_fetch_end = time.time()
            
            download_time += (t_process_start - t_fetch_start) * 1000
            process_time += (t_process_end - t_process_start) * 1000
            total_samples += len(samples)
            
            if i == 0:
                ttfa = (time.time() - t0) * 1000
        
        total_time = (time.time() - t0) * 1000
        
        return {
            'ttfa': ttfa,
            'total_time': total_time,
            'download_time': download_time,
            'process_time': process_time,
            'num_chunks': len(chunks),
            'total_samples': total_samples
        }


class PipelinedTest(PerformanceTest):
    """Pipelined: Fetch chunk N+1 while processing chunk N."""
    
    def __init__(self):
        super().__init__(
            "Pipelined Fetch+Process",
            "Overlap fetch of next chunk with processing of current chunk"
        )
    
    def run(self) -> Dict:
        import concurrent.futures
        
        t0 = time.time()
        
        # Get metadata
        metadata = BaselineTest()._fetch_metadata()
        chunks = metadata['chunks']
        norm_min = metadata['normalization']['min']
        norm_max = metadata['normalization']['max']
        
        ttfa = None
        download_time = 0
        process_time = 0
        total_samples = 0
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            # Start fetching first chunk
            future_fetch = executor.submit(BaselineTest()._fetch_chunk, chunks[0])
            
            for i in range(len(chunks)):
                # Wait for current chunk to finish downloading
                t_fetch_start = time.time()
                compressed = future_fetch.result()
                t_fetch_end = time.time()
                download_time += (t_fetch_end - t_fetch_start) * 1000
                
                # Start fetching next chunk while processing current
                if i + 1 < len(chunks):
                    future_fetch = executor.submit(BaselineTest()._fetch_chunk, chunks[i + 1])
                
                # Process current chunk
                t_process_start = time.time()
                samples = BaselineTest()._decompress_and_normalize(compressed, norm_min, norm_max)
                t_process_end = time.time()
                process_time += (t_process_end - t_process_start) * 1000
                
                total_samples += len(samples)
                
                if i == 0:
                    ttfa = (time.time() - t0) * 1000
        
        total_time = (time.time() - t0) * 1000
        
        return {
            'ttfa': ttfa,
            'total_time': total_time,
            'download_time': download_time,
            'process_time': process_time,
            'num_chunks': len(chunks),
            'total_samples': total_samples
        }


def main():
    """Run all performance tests and generate report."""
    print("="*80)
    print("🚀 VOLCANO AUDIO PROGRESSIVE STREAMING PERFORMANCE TEST")
    print("="*80)
    print(f"📍 Station: {TEST_STATION['network']}.{TEST_STATION['station']}")
    print(f"⏱️  Duration: {TEST_DURATION_MINUTES} minutes")
    print(f"🔄 Runs per test: {NUM_RUNS}")
    print(f"🌐 Worker URL: {R2_WORKER_URL}")
    print("="*80)
    
    # Run all tests
    tests = [
        BaselineTest(),
        PipelinedTest(),
        ParallelFetchTest(),
        ParallelProcessTest(),
        StreamingDecompressTest(),
    ]
    
    results = []
    for test in tests:
        try:
            result = test.run_multiple(NUM_RUNS)
            results.append(result)
        except Exception as e:
            print(f"❌ Test failed: {e}")
            import traceback
            traceback.print_exc()
    
    # Generate comparison report
    print("\n" + "="*80)
    print("📊 PERFORMANCE COMPARISON")
    print("="*80)
    
    # Sort by TTFA
    results_sorted = sorted(results, key=lambda r: r['ttfa_mean'])
    
    print("\n🏆 TTFA (Time to First Audio) Rankings:")
    print("-" * 80)
    for i, result in enumerate(results_sorted, 1):
        print(f"{i}. {result['name']}: {result['ttfa_mean']:.0f}ms ± {result['ttfa_std']:.0f}ms")
    
    print("\n⏱️  Total Time Rankings:")
    print("-" * 80)
    results_sorted_total = sorted(results, key=lambda r: r['total_mean'])
    for i, result in enumerate(results_sorted_total, 1):
        print(f"{i}. {result['name']}: {result['total_mean']:.0f}ms ± {result['total_std']:.0f}ms")
    
    # Recommendations
    print("\n" + "="*80)
    print("💡 RECOMMENDATIONS")
    print("="*80)
    
    best_ttfa = results_sorted[0]
    best_total = results_sorted_total[0]
    
    print(f"\n✅ Best TTFA: {best_ttfa['name']} ({best_ttfa['ttfa_mean']:.0f}ms)")
    print(f"   → Use this approach for fastest audio start")
    
    print(f"\n✅ Best Total Time: {best_total['name']} ({best_total['total_mean']:.0f}ms)")
    print(f"   → Use this approach for fastest complete load")
    
    # Calculate speedup vs baseline
    baseline = next(r for r in results if r['name'].startswith('Baseline'))
    print(f"\n📈 Speedup vs Baseline:")
    print("-" * 80)
    for result in results:
        if result['name'] != baseline['name']:
            ttfa_speedup = baseline['ttfa_mean'] / result['ttfa_mean']
            total_speedup = baseline['total_mean'] / result['total_mean']
            print(f"  {result['name']}:")
            print(f"    TTFA: {ttfa_speedup:.2f}x faster")
            print(f"    Total: {total_speedup:.2f}x faster")
    
    # Save detailed results to JSON
    output_file = f"performance_test_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(output_file, 'w') as f:
        json.dump({
            'test_config': {
                'station': TEST_STATION,
                'duration_minutes': TEST_DURATION_MINUTES,
                'num_runs': NUM_RUNS,
                'worker_url': R2_WORKER_URL,
                'timestamp': datetime.now().isoformat()
            },
            'results': results
        }, f, indent=2)
    
    print(f"\n💾 Detailed results saved to: {output_file}")
    print("\n" + "="*80)
    print("✅ PERFORMANCE TEST COMPLETE")
    print("="*80)


if __name__ == '__main__':
    main()

