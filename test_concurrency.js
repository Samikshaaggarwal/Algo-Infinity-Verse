import { processInBatches } from './backend/utils/concurrency.js';
import { fetchBlobsConcurrently } from './backend/repository-analyzer/graphqlFetcher.js';

async function testConcurrencyUtility() {
  console.log("=== Testing Concurrency Utility ===");
  const items = Array.from({ length: 20 }, (_, i) => i + 1);
  
  let activeCount = 0;
  let maxActiveCount = 0;

  const asyncTask = async (item, index) => {
    activeCount++;
    if (activeCount > maxActiveCount) {
      maxActiveCount = activeCount;
    }
    
    // Simulate varying work duration
    const delay = Math.random() * 100 + 50;
    await new Promise(res => setTimeout(res, delay));
    
    activeCount--;
    return item * 2;
  };

  const limit = 4;
  const startTime = Date.now();
  const results = await processInBatches(items, asyncTask, limit);
  const duration = Date.now() - startTime;

  console.log(`Expected max concurrency: ${limit}`);
  console.log(`Actual max concurrency:   ${maxActiveCount}`);
  
  if (maxActiveCount > limit) {
    throw new Error("Concurrency limit exceeded!");
  }
  
  // Verify ordering
  for (let i = 0; i < items.length; i++) {
    if (results[i] !== items[i] * 2) {
      throw new Error(`Ordering failed at index ${i}. Expected ${items[i] * 2}, got ${results[i]}`);
    }
  }

  console.log(`Ordered results verified.`);
  console.log(`Execution time: ${duration}ms\n`);
}

async function testEdgeCases() {
  console.log("=== Testing Edge Cases ===");

  // Edge Case 1: Empty array
  const emptyRes = await processInBatches([], async () => 1, 5);
  if (emptyRes.length !== 0) throw new Error("Failed Edge Case 1: Empty array should return empty array");
  console.log("✓ Edge Case 1 passed: Empty array input");

  // Edge Case 2: Array smaller than limit
  const smallRes = await processInBatches([1, 2], async (v) => v * 10, 5);
  if (smallRes.length !== 2 || smallRes[0] !== 10 || smallRes[1] !== 20) throw new Error("Failed Edge Case 2: Array smaller than limit");
  console.log("✓ Edge Case 2 passed: Array smaller than limit");

  // Edge Case 3: Rejection handling
  try {
    await processInBatches([1, 2, 3], async (v) => {
      if (v === 2) throw new Error("Simulated Failure");
      return v;
    }, 2);
    throw new Error("Failed Edge Case 3: Should have thrown an error");
  } catch (err) {
    if (err.message !== "Simulated Failure") throw new Error("Failed Edge Case 3: Wrong error thrown");
    console.log("✓ Edge Case 3 passed: Promise rejection propagates correctly");
  }

  // Edge Case 4: Synchronous returns / non-promises
  const syncRes = await processInBatches([1, 2, 3], (v) => v + 1, 2);
  if (syncRes[0] !== 2 || syncRes[2] !== 4) throw new Error("Failed Edge Case 4: Synchronous returns");
  console.log("✓ Edge Case 4 passed: Synchronous non-promise returns");
}

async function testGraphQLFetcher() {
  console.log("=== Testing GraphQL Fetcher Integration ===");
  const filePaths = Array.from({ length: 50 }, (_, i) => `src/file_${i}.js`);
  
  const startTime = Date.now();
  const blobs = await fetchBlobsConcurrently(filePaths, "owner", "repo");
  const duration = Date.now() - startTime;
  
  console.log(`Successfully fetched ${blobs.length} blobs in batches.`);
  console.log(`Execution time: ${duration}ms`);
}

async function runTests() {
  try {
    await testConcurrencyUtility();
    await testEdgeCases();
    await testGraphQLFetcher();
    console.log("\nAll concurrency tests passed successfully!");
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}

runTests();
