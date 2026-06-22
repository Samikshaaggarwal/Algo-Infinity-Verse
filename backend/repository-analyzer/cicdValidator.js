import * as yaml from 'js-yaml';
import { processInBatches } from '../utils/concurrency.js';

/**
 * Validates a GitHub Actions workflow YAML to detect CI/CD practices.
 * Returns an object with metrics on dependencies, tests, and a calculated score.
 */
export function analyzeWorkflow(yamlString) {
  try {
    const doc = yaml.load(yamlString);
    if (!doc || typeof doc !== 'object') {
      return { score: 0, hasJobs: false, hasDependencies: false, hasTests: false };
    }

    const jobs = doc.jobs || {};
    const jobKeys = Object.keys(jobs);

    if (jobKeys.length === 0) {
      return { score: 20, hasJobs: false, hasDependencies: false, hasTests: false };
    }

    let hasDependencies = false;
    let hasTests = false;

    // Common patterns
    const depPatterns = /npm (install|ci)|pip install|yarn(\s+install)?|go mod download/i;
    const testPatterns = /npm (run )?test|jest|pytest|vitest|go test|mvn test/i;

    for (const key of jobKeys) {
      const job = jobs[key];
      const steps = job.steps || [];

      for (const step of steps) {
        if (step.run) {
          if (depPatterns.test(step.run)) hasDependencies = true;
          if (testPatterns.test(step.run)) hasTests = true;
        }
        if (step.uses) {
          // Check for common test actions if needed
          if (step.uses.includes('cypress-io/github-action')) hasTests = true;
          if (step.uses.includes('actions/setup-')) hasDependencies = true; // Assuming setup usually precedes dep install
        }
      }
    }

    let score = 20; // Has jobs
    if (hasDependencies && !hasTests) score = 50;
    if (!hasDependencies && hasTests) score = 75; // Unlikely but possible
    if (hasDependencies && hasTests) score = 100;

    return {
      score,
      hasJobs: true,
      hasDependencies,
      hasTests
    };

  } catch (err) {
    console.error("YAML parsing error:", err.message);
    return { score: 0, hasJobs: false, hasDependencies: false, hasTests: false, error: err.message };
  }
}

/**
 * Fetches workflow files from a public GitHub repository.
 * repoUrl format: https://github.com/owner/repo
 */
export async function fetchWorkflows(repoUrl) {
  try {
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) throw new Error("Invalid GitHub URL");

    const owner = match[1];
    const repo = match[2].replace(/\.git$/, '');

    // Fetch contents of .github/workflows
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows`;
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Algo-Infinity-Verse-Analyzer',
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!res.ok) {
      if (res.status === 404) return []; // No workflows directory
      throw new Error(`GitHub API returned ${res.status}`);
    }

    const files = await res.json();
    if (!Array.isArray(files)) return [];

    const yamlFiles = files.filter(f => f.name.endsWith('.yml') || f.name.endsWith('.yaml'));
    
    // Process workflow files concurrently with a limit of 3
    const workflows = await processInBatches(yamlFiles, async (file) => {
      const fileRes = await fetch(file.download_url);
      if (fileRes.ok) {
        const content = await fileRes.text();
        return { name: file.name, content };
      }
      return null;
    }, 3);

    return workflows.filter(w => w !== null);
  } catch (err) {
    console.error("Failed to fetch workflows:", err.message);
    throw err;
  }
}
