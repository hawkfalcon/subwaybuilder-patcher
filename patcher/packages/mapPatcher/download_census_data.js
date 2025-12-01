import fs from 'fs';
import config from './config.js';
import * as turf from '@turf/turf';

/**
 * Census Data Downloader for Subway Builder Patcher
 * 
 * This script fetches US Census data (Block Groups) for configured places
 * and generates demand_data.json with actual population and employment data.
 * 
 * Data Sources:
 * - TIGERweb API: Block Group boundaries
 * - Census ACS 5-Year API: Population data
 * - LODES API: Employment and commute flow data
 * 
 * Rate Limiting: Designed to work within 500 requests/day limit (no API key)
 */

const CENSUS_YEAR = config['census-year'] || '2021';
const CENSUS_API_KEY = config['census-api-key'] || null;
const DELAY_BETWEEN_REQUESTS = 100; // ms to avoid rate limiting

// ============================================================================
// TUNING PARAMETERS
// Adjust these to control job distribution, clustering, and commute patterns
// ============================================================================
const TUNING_PARAMS = {
  // Employment estimation
  jobRatio: 0.95,                    // Jobs per resident (0.95 = ~200k jobs for SBA)
  
  // Block aggregation (clustering)
  clusterThresholdMeters: 300,       // Distance threshold for merging blocks (300m = 1:3 ratio)
  
  // Gravity model for commute flows
  gravityExponent: 0.5,              // Distance decay exponent (lower = favor distant jobs)
                                     // 0.5 = very aggressive, 1.0 = moderate, 1.5 = conservative
  
  gravityMinDistance: 2500,          // Minimum distance for gravity calc (meters)
                                     // Higher = penalize short trips more heavily
  
  localJobBonus: 0.001,              // Multiplier for same-block jobs (0.001 = nearly eliminated)
                                     // Lower = discourage working where you live
  
  minFlowSize: 5,                    // Minimum commuters per flow to include
  minJobsPerBlock: 5,                // Minimum jobs to consider a block as employment center
  minPopPerBlock: 10,                // Minimum population to generate flows from a block
};

// Helper: Sleep function for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Make rate-limited fetch request
const rateLimitedFetch = async (url, options = {}) => {
  await sleep(DELAY_BETWEEN_REQUESTS);
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} - ${url}`);
  }
  return response;
};

/**
 * Step 1: Get Census Block Groups that intersect with bbox
 * Uses TIGERweb REST API to find block groups within the bounding box
 */
/**
 * Step 1: Get Census Blocks that intersect with bbox
 * Uses TIGERweb REST API (Layer 10 - Census Blocks 2020)
 * Fetches population (POP100) and internal point (INTPTLAT/LON) directly
 */
const getCensusBlocksInBbox = async (place) => {
  console.log(`Fetching census blocks for ${place.name} (${place.code})...`);
  
  const [minLon, minLat, maxLon, maxLat] = place.bbox;
  
  // TIGERweb API endpoint for Census Blocks (2020 vintage)
  // Layer 10 = Census Blocks
  const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/10/query?` +
    `geometry=${minLon},${minLat},${maxLon},${maxLat}&` +
    `geometryType=esriGeometryEnvelope&` +
    `spatialRel=esriSpatialRelIntersects&` +
    `inSR=4326&` +
    `outFields=GEOID,POP100,INTPTLAT,INTPTLON,AREALAND&` +
    `returnGeometry=false&` +
    `f=json`;
  
  console.log('  Fetching from TIGERweb API...');
  
  const response = await rateLimitedFetch(url);
  const data = await response.json();
  
  // Check for errors
  if (data.error) {
    console.error('API Error:', data.error);
    throw new Error(`TIGERweb API error: ${data.error.message}`);
  }
  
  // Check if we got features
  if (!data.features || data.features.length === 0) {
    console.error('API Response:', JSON.stringify(data, null, 2));
    throw new Error(`No census blocks found for ${place.name}`);
  }
  
  console.log(`Found ${data.features.length} census blocks`);
  
  // Process blocks
  const blocks = data.features
    .map(feature => {
      const props = feature.attributes;
      
      // Parse coordinates
      const lat = parseFloat(props.INTPTLAT);
      const lon = parseFloat(props.INTPTLON);
      const pop = props.POP100 || 0;
      
      // Skip invalid coordinates
      if (isNaN(lat) || isNaN(lon)) return null;
      
      return {
        geoid: props.GEOID,
        name: `Block ${props.GEOID}`,
        centroid: [lon, lat],
        population: pop,
        areaLand: props.AREALAND,
        // Parse hierarchy from GEOID (SSCCCTTTTTTBBBB)
        state: props.GEOID.substring(0, 2),
        county: props.GEOID.substring(2, 5),
        tract: props.GEOID.substring(5, 11),
        block: props.GEOID.substring(11, 15),
      };
    })
    .filter(b => b !== null)
    // Filter out blocks with 0 population to avoid "dots in ocean" and reduce processing
    .filter(b => b.population > 0);
    
  console.log(`  Filtered to ${blocks.length} populated blocks`);
  return blocks;
};

// Removed getPopulationData as it's now integrated into getCensusBlocksInBbox

/**
 * Step 3: Get employment data from LODES (Longitudinal Employer-Household Dynamics)
 * Note: LODES data is at the Census Block level, we'll aggregate to Block Groups
 * 
 * For simplicity and rate limiting, we'll use a heuristic approach:
 * - Estimate jobs based on population density and land use
 * - Use distance-based commute flow modeling
 */
// Job density constants (sq ft per job) - Copied from process_data.js
const squareFeetPerJob = {
  commercial: 150,
  industrial: 500,
  kiosk: 50,
  office: 150,
  retail: 300,
  supermarket: 300,
  warehouse: 500,
  religious: 100,
  cathedral: 100,
  chapel: 100,
  church: 100,
  kingdom_hall: 100,
  monastery: 100,
  mosque: 100,
  presbytery: 100,
  shrine: 100,
  synagogue: 100,
  temple: 100,
  bakehouse: 300,
  college: 250,
  fire_station: 500,
  government: 150,
  gatehouse: 150,
  hospital: 150,
  kindergarten: 100,
  museum: 300,
  public: 300,
  school: 100,
  train_station: 1000,
  transportation: 1000,
  university: 250,
  grandstand: 150,
  pavilion: 150,
  riding_hall: 150,
  sports_hall: 150,
  sports_centre: 150,
  stadium: 150,
};

/**
 * Helper: Load OSM buildings from raw_data if available
 */
const loadOSMBuildings = (place) => {
  const buildingsPath = `${import.meta.dirname}/raw_data/${place.code}/buildings.json`;
  
  if (!fs.existsSync(buildingsPath)) {
    console.log('  No OSM buildings.json found, using population-based job heuristic.');
    return [];
  }
  
  console.log('  Loading OSM buildings for job distribution...');
  try {
    const rawBuildings = JSON.parse(fs.readFileSync(buildingsPath, 'utf8'));
    
    const jobBuildings = rawBuildings
      .filter(b => b.tags && b.tags.building && squareFeetPerJob[b.tags.building])
      .map(b => {
        // Calculate area
        let area = 0;
        let centroid = null;
        
        if (b.type === 'way' && b.geometry && b.geometry.length >= 3) {
          const coords = b.geometry.map(p => [p.lon, p.lat]);
          // Close the ring if needed
          if (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1]) {
            coords.push(coords[0]);
          }
          const polygon = turf.polygon([coords]);
          area = turf.area(polygon) * 10.7639; // sq meters to sq ft
          centroid = turf.centroid(polygon).geometry.coordinates;
        } else if (b.bounds) {
          // Fallback for relations or simple bounds
          const width = turf.distance([b.bounds.minlon, b.bounds.minlat], [b.bounds.maxlon, b.bounds.minlat], {units: 'feet'});
          const height = turf.distance([b.bounds.minlon, b.bounds.minlat], [b.bounds.minlon, b.bounds.maxlat], {units: 'feet'});
          area = width * height;
          centroid = [(b.bounds.minlon + b.bounds.maxlon)/2, (b.bounds.minlat + b.bounds.maxlat)/2];
        }
        
        if (!centroid) return null;
        
        const levels = Math.max(parseInt(b.tags['building:levels']) || 1, 1);
        const sqFtPerJob = squareFeetPerJob[b.tags.building] || 200;
        const capacity = Math.max((area * levels) / sqFtPerJob, 1);
        
        return { centroid, capacity };
      })
      .filter(b => b !== null);
      
    console.log(`  Found ${jobBuildings.length} commercial/industrial buildings.`);
    return jobBuildings;
  } catch (e) {
    console.warn(`  Error loading buildings.json: ${e.message}`);
    return [];
  }
};

/**
 * Step 3: Get employment data
 * Uses OSM buildings to distribute jobs spatially if available
 * Fallback to population-based heuristic
 */
const estimateEmploymentData = (blocks, place) => {
  console.log('Estimating employment data...');
  
  const employmentData = {};
  const osmBuildings = loadOSMBuildings(place);
  
  if (osmBuildings.length > 0) {
    // Strategy: Distribute total target jobs based on building capacity
    const totalPopulation = blocks.reduce((sum, b) => sum + b.population, 0);
    const targetTotalJobs = Math.round(totalPopulation * TUNING_PARAMS.jobRatio);
    const totalCapacity = osmBuildings.reduce((sum, b) => sum + b.capacity, 0);
    
    console.log(`  Distributing ${targetTotalJobs.toLocaleString()} jobs across ${osmBuildings.length} buildings (Ratio: ${TUNING_PARAMS.jobRatio})...`);
    
    // Create a spatial index for blocks (simple array for now, nearestPoint is fast enough)
    const blockPoints = turf.featureCollection(
      blocks.map(b => turf.point(b.centroid, { geoid: b.geoid }))
    );
    
    // Initialize job counts
    blocks.forEach(b => employmentData[b.geoid] = 0);
    
    // Assign jobs from buildings to nearest block
    osmBuildings.forEach(b => {
      const jobs = (b.capacity / totalCapacity) * targetTotalJobs;
      const nearest = turf.nearestPoint(turf.point(b.centroid), blockPoints);
      const blockGeoid = nearest.properties.geoid;
      
      employmentData[blockGeoid] = (employmentData[blockGeoid] || 0) + jobs;
    });
    
    // Round job counts
    Object.keys(employmentData).forEach(k => {
      employmentData[k] = Math.round(employmentData[k]);
    });
    
  } else {
    // Fallback: Uniform distribution based on population
    blocks.forEach(block => {
      const estimatedJobs = Math.round(block.population * TUNING_PARAMS.jobRatio);
      employmentData[block.geoid] = estimatedJobs;
    });
  }
  
  // Count blocks with jobs
  const blocksWithJobs = Object.values(employmentData).filter(j => j > 0).length;
  console.log(`  Assigned jobs to ${blocksWithJobs} blocks (out of ${blocks.length})`);
  
  return employmentData;
};

/**
 * Step 4: Generate commute flows between blocks
 * Uses gravity model: flow proportional to (pop_origin * jobs_dest) / distance^2
 */
const generateCommuteFlows = (blocks, employmentData) => {
  console.log('Generating commute flows...');
  
  const flows = [];
  let flowId = 0;
  
  // For each residential block (origin)
  blocks.forEach(origin => {
    const originPop = origin.population;
    if (originPop < TUNING_PARAMS.minPopPerBlock) return; // Skip very low population areas
    
    // Calculate flows to each employment block (destination)
    const potentialFlows = [];
    
    // Optimization: Only consider blocks within a certain distance or limit to top N destinations
    // For now, we'll process all but might need optimization for large areas
    
    blocks.forEach(dest => {
      if (origin.geoid === dest.geoid) {
        // Same block - eliminate local work entirely
        const sameAreaJobs = employmentData[dest.geoid] || 0;
        if (sameAreaJobs > 0) {
          potentialFlows.push({
            dest: dest.geoid,
            jobs: sameAreaJobs,
            distance: 0,
            attractiveness: sameAreaJobs * TUNING_PARAMS.localJobBonus,
          });
        }
        return;
      }
      
      const destJobs = employmentData[dest.geoid] || 0;
      if (destJobs < TUNING_PARAMS.minJobsPerBlock) return; // Skip very low employment areas
      
      // Calculate distance between centroids
      const distance = turf.distance(
        turf.point(origin.centroid),
        turf.point(dest.centroid),
        { units: 'meters' }
      );
      
      // Gravity model: attractiveness = jobs / (distance^alpha)
      // See TUNING_PARAMS at top of file for parameter explanations
      const attractiveness = destJobs / Math.pow(
        Math.max(distance, TUNING_PARAMS.gravityMinDistance), 
        TUNING_PARAMS.gravityExponent
      );
      
      potentialFlows.push({
        dest: dest.geoid,
        jobs: destJobs,
        distance: distance,
        attractiveness: attractiveness,
      });
    });
    
    // Calculate total attractiveness to normalize
    const totalAttractiveness = potentialFlows.reduce((sum, f) => sum + f.attractiveness, 0);
    
    if (totalAttractiveness === 0) return;
    
    // Distribute origin population across destinations based on attractiveness
    potentialFlows.forEach(flow => {
      const flowSize = Math.round(originPop * (flow.attractiveness / totalAttractiveness));
      
      if (flowSize >= TUNING_PARAMS.minFlowSize) { // Only include significant flows
        // Split large flows into multiple smaller ones (max 400 per flow, as per original code)
        const splits = Math.ceil(flowSize / 400);
        const sizePerSplit = Math.round(flowSize / splits);
        
        for (let i = 0; i < splits; i++) {
          flows.push({
            id: flowId.toString(),
            residenceId: origin.geoid,
            jobId: flow.dest,
            size: sizePerSplit,
            drivingDistance: Math.round(flow.distance),
            drivingSeconds: Math.round(flow.distance * 0.12), // Same heuristic as original
          });
          flowId++;
        }
      }
    });
  });
  
  console.log(`  Generated ${flows.length} commute flows`);
  return flows;
};

/**
 * Step 5: Format data as demand_data.json
 */
const formatDemandData = (blocks, employmentData, flows) => {
  console.log('Formatting demand data...');
  
  // Create points array
  const points = blocks.map(block => {
    const jobs = employmentData[block.geoid] || 0;
    
    // Find all flows that reference this block
    const popIds = flows
      .filter(f => f.residenceId === block.geoid || f.jobId === block.geoid)
      .map(f => f.id);
    
    return {
      id: block.geoid,
      location: block.centroid,
      jobs: jobs,
      residents: block.population,
      popIds: popIds,
    };
  });
  
  return {
    points: points,
    pops: flows,
  };
};

/**
 * Helper: Aggregate blocks into clusters to reduce node count
 * Uses greedy clustering with a distance threshold
 */
const aggregateBlocks = (blocks, employmentData, thresholdMeters = 400) => {
  console.log(`Aggregating ${blocks.length} blocks (threshold: ${thresholdMeters}m)...`);
  
  // Sort blocks by population (descending) to prioritize population centers as cluster seeds
  const sortedBlocks = [...blocks].sort((a, b) => b.population - a.population);
  
  const clusters = [];
  
  sortedBlocks.forEach(block => {
    const blockPoint = turf.point(block.centroid);
    let addedToCluster = false;
    
    // Try to find an existing cluster to join
    for (const cluster of clusters) {
      const clusterPoint = turf.point(cluster.centroid);
      const distance = turf.distance(blockPoint, clusterPoint, { units: 'meters' });
      
      if (distance < thresholdMeters) {
        // Merge into cluster
        cluster.subBlocks.push(block);
        cluster.population += block.population;
        cluster.jobs += (employmentData[block.geoid] || 0);
        
        // Update centroid (weighted average)
        // Note: For simplicity, we're just keeping the seed centroid, or we could re-average
        // Keeping seed centroid is stable and keeps points on actual block centers
        
        addedToCluster = true;
        break;
      }
    }
    
    if (!addedToCluster) {
      // Create new cluster
      clusters.push({
        geoid: block.geoid, // Inherit ID from seed block
        centroid: block.centroid,
        population: block.population,
        jobs: (employmentData[block.geoid] || 0),
        subBlocks: [block]
      });
    }
  });
  
  console.log(`  Merged into ${clusters.length} clusters (Ratio: 1:${(blocks.length / clusters.length).toFixed(1)})`);
  return clusters;
};

/**
 * Main execution
 */
const fetchCensusData = async (place) => {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing ${place.name} (${place.code})`);
    console.log('='.repeat(60));
    
    // Step 1: Get census blocks (with population and location)
    const blocks = await getCensusBlocksInBbox(place);
    
    if (blocks.length === 0) {
      throw new Error(`No populated census blocks found for ${place.name}`);
    }
    
    // Step 2: Estimate employment
    const employmentData = estimateEmploymentData(blocks, place);
    
    // Step 2.5: Aggregate blocks
    // Merge nearby blocks to reduce graph complexity
    const clusters = aggregateBlocks(blocks, employmentData, TUNING_PARAMS.clusterThresholdMeters);
    
    // Create a new employment map for the clusters
    const clusterEmployment = {};
    clusters.forEach(c => clusterEmployment[c.geoid] = c.jobs);
    
    // Step 3: Generate commute flows (using clusters)
    const flows = generateCommuteFlows(clusters, clusterEmployment);
    
    // Step 4: Format output
    const demandData = formatDemandData(clusters, clusterEmployment, flows);
    
    // Write to file
    const outputPath = `${import.meta.dirname}/processed_data/${place.code}/demand_data.json`;
    fs.writeFileSync(outputPath, JSON.stringify(demandData), { encoding: 'utf8' });
    
    // Calculate totals
    const totalPopulation = clusters.reduce((sum, c) => sum + c.population, 0);
    const totalJobs = clusters.reduce((sum, c) => sum + c.jobs, 0);
    
    console.log(`\n✓ Successfully generated demand_data.json for ${place.name}`);
    console.log(`  Census Blocks: ${blocks.length}`);
    console.log(`  Clusters: ${clusters.length}`);
    console.log(`  Total Population: ${totalPopulation.toLocaleString()}`);
    console.log(`  Total Jobs: ${totalJobs.toLocaleString()}`);
    console.log(`  Commute Flows: ${flows.length}`);
    
  } catch (error) {
    console.error(`\n✗ Error processing ${place.name}:`, error.message);
    throw error;
  }
};

// Run for all configured places
if (!fs.existsSync(`${import.meta.dirname}/processed_data`)) {
  fs.mkdirSync(`${import.meta.dirname}/processed_data`);
}

for (const place of config.places) {
  if (!fs.existsSync(`${import.meta.dirname}/processed_data/${place.code}`)) {
    fs.mkdirSync(`${import.meta.dirname}/processed_data/${place.code}`);
  }
  await fetchCensusData(place);
}

console.log('\n' + '='.repeat(60));
console.log('All places processed successfully!');
console.log('='.repeat(60));
