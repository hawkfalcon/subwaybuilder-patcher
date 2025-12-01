# Census Data Integration for Subway Builder Patcher

This script (`download_census_data.js`) generates `demand_data.json` using actual US Census population data instead of OSM building-based heuristics.

## Overview

The original `process_data.js` script estimates population and employment by analyzing OSM building footprints and applying heuristics (e.g., square footage per resident). This new script uses **actual Census data** for more accurate population and employment statistics.

## Data Sources

1. **TIGERweb REST API (Layer 10)**: Census Blocks (2020) boundaries, population (`POP100`), and internal points (`INTPTLAT`/`INTPTLON`).
2. **OSM Building Data** (Optional): Used to spatially distribute jobs to commercial/industrial areas.
3. **Gravity Model**: Commute flow estimation based on population and job distribution.

## Usage

### Prerequisites

- Node.js installed
- Internet connection for Census API access
- No API key required (uses TIGERweb directly)
- **Recommended**: Run `download_data.js` first to fetch OSM data (for accurate job locations)

### Running the Script

```bash
# From the project root
node ./patcher/packages/mapPatcher/download_census_data.js
```

The script will:
1. Read place configurations from `config.js`
2. Fetch **Census Blocks** for each place's bbox from TIGERweb
3. Filter out blocks with 0 population (removes ocean/wilderness points)
4. **Load OSM Buildings** (if available) to find commercial/industrial zones
5. Estimate employment:
   - Target: 0.4 jobs per resident (macro-level)
   - Distribution: Proportional to commercial building capacity (micro-level)
   - Fallback: If no OSM data, distributes jobs evenly (not recommended)
6. Generate commute flows using gravity model
7. Write `demand_data.json` to `processed_data/{PLACE_CODE}/`

### Configuration

No special configuration needed in `config.js`.

## Output Format

The generated `demand_data.json` matches the existing format:

```javascript
{
  "points": [
    {
      "id": "060830029372001",     // Census Block GEOID (15 digits)
      "location": [-119.97, 34.37], // Internal Point coordinates
      "jobs": 0,                     // Jobs (0 for residential blocks)
      "residents": 38,               // Actual Census 2020 population
      "popIds": ["0", "1", "2"]     // References to commute flows
    },
    {
      "id": "060830029372005",     // Commercial Block
      "location": [-119.96, 34.36],
      "jobs": 450,                   // High job count (commercial zone)
      "residents": 12,
      "popIds": [...]
    }
  ],
  "pops": [
    {
      "id": "0",
      "residenceId": "060830029372001",
      "jobId": "060830029372005",
      "size": 5,                      // Commuters
      "drivingDistance": 1200,        // Meters
      "drivingSeconds": 144           // Estimated travel time
    }
  ]
}
```

## Comparison: Census vs. OSM Approach

### Santa Barbara (SBA) Results

| Metric | Census Approach (Hybrid) | OSM Approach |
|--------|--------------------------|--------------|
| **Granularity** | **2,016 Census Blocks** | ~Variable (Voronoi cells) |
| **Total Population** | **208,971** (2020 actual) | ~Estimated from buildings |
| **Total Jobs** | 83,581 (estimated) | ~Estimated from buildings |
| **Job Distribution** | **Clustered (231 blocks)** | Clustered (Commercial zones) |
| **Commute Flows** | **6,802** | ~Variable |
| **Data Source** | Census 2020 + OSM | OSM building footprints |

### Advantages of Census Approach

✅ **High Granularity**: Uses Census Blocks (city block level)  
✅ **Smart Aggregation**: Merges nearby blocks (300m radius) to optimize simulation (1:3 ratio)  
✅ **Accurate Population**: Real Decennial 2020 counts  
✅ **Precise Locations**: Uses official internal points (centroids)  
✅ **Realistic Commutes**: Jobs clustered in commercial areas (using OSM), forcing travel  
✅ **Realistic Modeshare**: Gravity model tuned for US cities (11% walking, avg 7.9km commute)  
✅ **Clean Data**: Filters out unpopulated areas (ocean, wilderness)  

### Limitations

⚠️ **Employment Estimation**: Uses 0.95 jobs/resident target (tuned for SBA) + OSM capacity  
⚠️ **Commute Flows**: Gravity model estimation (not actual commute patterns)  
⚠️ **Gravity Model**: Aggressively tuned (exponent 0.7, min distance 1500m) - may need adjustment for other cities  
⚠️ **US Only**: Census API only covers United States    

## Technical Details

### Rate Limiting

- Script includes 100ms delay between requests to respect TIGERweb limits.

### Census Geography Levels

- **Census Block**: Smallest geography (city block size)
- **GEOID Format**: 15 digits (e.g., `060830029372001`)
  - `06` = State (California)
  - `083` = County (Santa Barbara)
  - `002937` = Tract
  - `2001` = Block

### API Endpoints Used

1. **TIGERweb**: `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/10/query`

## Future Enhancements

Potential improvements (see `task.md` for details):

- [ ] Use actual LODES employment data instead of heuristics
- [ ] Use LODES Origin-Destination data for real commute flows
- [ ] Fetch actual block group geometries and centroids
- [ ] Add caching to avoid repeated API calls
- [ ] Support for multiple Census data vintages
- [ ] Fallback to OSM data if Census data unavailable

## Troubleshooting

### "No block groups found"
- Check that your bbox is within the United States
- Verify bbox format: `[minLon, minLat, maxLon, maxLat]`

### "Failed to execute query"
- TIGERweb API may be temporarily unavailable
- Try again in a few minutes

### "HTTP 429: Too Many Requests"
- You've exceeded the 500/day limit
- Get a free API key or wait 24 hours

## References

- [Census API Documentation](https://www.census.gov/data/developers/data-sets.html)
- [TIGERweb Documentation](https://tigerweb.geo.census.gov/tigerwebmain/TIGERweb_main.html)
- [ACS 5-Year Estimates](https://www.census.gov/data/developers/data-sets/acs-5year.html)
- [LODES Data](https://lehd.ces.census.gov/data/)
