# Performance Optimizations

This build is optimized for faster repeated section checks and faster transfer of large audit responses.

- Python reuses HTTP connections per worker thread.
- Public page extraction is cached for 60 seconds (LRU, bounded to 128 pages).
- SerpApi results are cached for 45 seconds (LRU, bounded to 128 searches).
- Site crawls process up to 8 pages concurrently instead of serially.
- FastAPI compresses large JSON/HTML responses with GZip.
- Frontend API calls deduplicate simultaneous identical requests.
- Frontend reuses successful identical section responses for 20 seconds.
- Static assets use short browser caching with ETag/Last-Modified support.

The cache windows are intentionally short so the agent remains responsive without making results stale for long periods. Deep SERP/Gemini tasks can still take longer because they depend on external provider response time.
