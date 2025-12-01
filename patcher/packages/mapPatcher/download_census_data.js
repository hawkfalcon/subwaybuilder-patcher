import fs from 'fs';
import config from './config.js';
import * as turf from '@turf/turf';

/**
 * Census Data Downloader for Subway Builder Patcher
 * 
 * This script fetches US Census data for configured places
 * and generates demand_data.json with actual population and employment data.
 * 
 * Data Sources:
 * - TIGERweb API: Census Block boundaries and population (2020)
 * - LODES: Employment data (2021)
 * 
 * No API key required for either data source.
 */

const DELAY_BETWEEN_REQUESTS = 100; // ms to avoid rate limiting

// ============================================================================
// TUNING PARAMETERS
// Adjust these to control job distribution, clustering, and commute patterns
// ============================================================================
const TUNING_PARAMS = {
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
    .filter(b => b !== null);
    // .filter(b => b.population > 0); // Removed to include commercial-only blocks
    
  console.log(`  Filtered to ${blocks.length} populated blocks`);
  return blocks;
};

// Removed getPopulationData as it's now integrated into getCensusBlocksInBbox

/**
 * Step 3: Get employment data from LODES (Longitudinal Employer-Household Dynamics)
 * Downloads and parses the Workplace Area Characteristics (WAC) file for the state.
 */
import zlib from 'zlib';
import readline from 'readline';
import { pipeline } from 'stream';
import { promisify } from 'util';

const streamPipeline = promisify(pipeline);

const downloadLodesData = async (stateCode) => {
  const state = stateCode.toLowerCase();
  const filename = `${state}_wac_S000_JT00_2021.csv.gz`;
  const url = `https://lehd.ces.census.gov/data/lodes/LODES8/${state}/wac/${filename}`;
  const outputDir = `${import.meta.dirname}/raw_data/LODES`;
  const outputPath = `${outputDir}/${filename}`;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (fs.existsSync(outputPath)) {
    console.log(`  Using cached LODES data: ${filename}`);
    return outputPath;
  }

  console.log(`  Downloading LODES data from ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download LODES data: ${response.statusText}`);
  }

  const fileStream = fs.createWriteStream(outputPath);
  await streamPipeline(response.body, fileStream);
  console.log(`  Downloaded LODES data to ${outputPath}`);
  return outputPath;
};

const parseLodesData = async (filePath, targetBlockGeoids) => {
  console.log('  Parsing LODES data...');
  const jobCounts = {};
  const targetBlocks = new Set(targetBlockGeoids);
  
  const fileStream = fs.createReadStream(filePath);
  const unzipStream = zlib.createGunzip();
  const rl = readline.createInterface({
    input: fileStream.pipe(unzipStream),
    crlfDelay: Infinity
  });

  let header = null;
  let geoidIdx = -1;
  let jobsIdx = -1;
  let count = 0;

  for await (const line of rl) {
    if (!header) {
      header = line.split(',');
      geoidIdx = header.indexOf('w_geocode');
      jobsIdx = header.indexOf('C000'); // Total jobs
      continue;
    }

    const cols = line.split(',');
    const geoid = cols[geoidIdx];
    
    // Only store data for blocks we care about (in our target area)
    if (targetBlocks.has(geoid)) {
      const jobs = parseInt(cols[jobsIdx], 10) || 0;
      if (jobs > 0) {
        jobCounts[geoid] = jobs;
        count += jobs;
      }
    }
  }

  console.log(`  Found ${count.toLocaleString()} jobs in the target area from LODES data.`);
  return jobCounts;
};

/**
 * Step 3: Get employment data from LODES
 */
const getEmploymentData = async (blocks) => {
  console.log('Fetching employment data from LODES...');
  
  const stateFips = blocks[0].state;
  const fipsToPostal = {
    '06': 'ca',
    '36': 'ny',
    '48': 'tx',
    '12': 'fl',
    '17': 'il',
    '42': 'pa',
    '39': 'oh',
    '13': 'ga',
    '37': 'nc',
    '26': 'mi'
  };
  
  const stateCode = fipsToPostal[stateFips];
  if (!stateCode) {
    throw new Error(`Unsupported state FIPS code: ${stateFips}. Please add to fipsToPostal mapping.`);
  }

  const lodesPath = await downloadLodesData(stateCode);
  const blockGeoids = blocks.map(b => b.geoid);
  const realJobCounts = await parseLodesData(lodesPath, blockGeoids);
  
  // Fill in the data
  const employmentData = {};
  blocks.forEach(b => {
    employmentData[b.geoid] = realJobCounts[b.geoid] || 0;
  });
  
  const totalJobs = Object.values(employmentData).reduce((a, b) => a + b, 0);
  console.log(`  Total jobs from LODES: ${totalJobs.toLocaleString()}`);
  
  return employmentData;
};

/**
 * Step 4: Generate commute flows between blocks
 * Uses gravity model: flow proportional to (pop_origin * jobs_dest) / distance^2
 * 
 * Low-population blocks are merged into their nearest neighbor to preserve total population
 * while reducing flow complexity.
 */
const generateCommuteFlows = (blocks, employmentData) => {
  console.log('Generating commute flows...');
  
  // Step 1: Merge low-population blocks into nearest neighbors
  const adjustedPopulation = {};
  const lowPopBlocks = [];
  const normalBlocks = [];
  
  // Initialize adjusted population and categorize blocks
  blocks.forEach(block => {
    adjustedPopulation[block.geoid] = block.population;
    if (block.population > 0 && block.population < TUNING_PARAMS.minPopPerBlock) {
      lowPopBlocks.push(block);
    } else if (block.population >= TUNING_PARAMS.minPopPerBlock) {
      normalBlocks.push(block);
    }
  });
  
  // Merge each low-pop block into its nearest normal block
  if (normalBlocks.length > 0) {
    const normalBlockPoints = turf.featureCollection(
      normalBlocks.map(b => turf.point(b.centroid, { geoid: b.geoid }))
    );
    
    lowPopBlocks.forEach(lowBlock => {
      const nearest = turf.nearestPoint(turf.point(lowBlock.centroid), normalBlockPoints);
      const nearestGeoid = nearest.properties.geoid;
      
      // Transfer population to nearest block
      adjustedPopulation[nearestGeoid] += lowBlock.population;
      adjustedPopulation[lowBlock.geoid] = 0; // Zero out the low-pop block
    });
    
    console.log(`  Merged ${lowPopBlocks.length} low-population blocks into ${normalBlocks.length} neighbors`);
  }
  
  const flows = [];
  let flowId = 0;
  
  // For each residential block (origin)
  blocks.forEach(origin => {
    const originPop = adjustedPopulation[origin.geoid];
    if (originPop < TUNING_PARAMS.minPopPerBlock) return; // Skip blocks with no adjusted population
    
    // Calculate flows to each employment block (destination)
    const potentialFlows = [];
    
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
    
    // Step 2: Estimate employment
    const employmentData = await getEmploymentData(blocks);
    
    // Step 2.5: Filter out blocks with no population AND no jobs
    const activeBlocks = blocks.filter(b => {
      const jobs = employmentData[b.geoid] || 0;
      return b.population > 0 || jobs > 0;
    });
    
    console.log(`  Filtered to ${activeBlocks.length} active blocks (from ${blocks.length} total)`);
    
    if (activeBlocks.length === 0) {
      throw new Error(`No populated or employed census blocks found for ${place.name}`);
    }
    
    // Step 2.6: Aggregate blocks
    // Merge nearby blocks to reduce graph complexity
    const clusters = aggregateBlocks(activeBlocks, employmentData, TUNING_PARAMS.clusterThresholdMeters);
    
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
