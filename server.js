import crypto from "crypto";
import fs from "fs/promises";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { initializeFirebase, getDb, COLLECTIONS } from "./firebase.js";
import multer from "multer";
import { extractResumeText } from "./backend/resume-analyzer/parser.js";
import { calculateATS } from "./backend/resume-analyzer/atsScore.js";
import { findMissingSkills } from "./backend/resume-analyzer/skills.js";
import { getSuggestions } from "./backend/resume-analyzer/suggestions.js";
import { analyzeWorkflow } from "./backend/repository-analyzer/cicdValidator.js";
import { VCSFactory } from "./backend/vcs/VCSFactory.js";
import { enqueueBulkAudit, getBatchProgress } from "./backend/jobs/queue.js";
import "./backend/jobs/worker.js"; // Initialize worker
import { parse as csvParse } from "csv-parse/sync";
import { v4 as uuidv4 } from "uuid";
import { handleReportRequest } from "./backend/reports/reportGenerator.js";
import { getUserBenchmark } from "./backend/benchmarking/percentileService.js";
import { Server as SocketIOServer } from "socket.io";
import { 
  SESSION_MAX_AGE_SECONDS, getClientIdentifier, isSignupRateLimited, 
  recordSignupAttempt, normalizeAuthDelay, createSessionToken, 
  verifySessionToken, hashPassword, passwordMatches, validateSignup 
} from "./backend/services/auth.service.js";
import { applySM2 } from "./backend/services/memory.service.js";
import { sendVerificationEmail } from "./backend/services/email.service.js";
import {
  createBattle,
  joinBattle,
  submitSolution,
  getBattle,
  getHistory,
} from "./pages/Dsa-Battle/Battleservice.js";

const upload = multer({ storage: multer.memoryStorage() }).single("resume");
const uploadCsv = multer({ storage: multer.memoryStorage() }).single("csv");
const userSocketMap = new Map();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");
const TEAM_PROFILES_FILE = path.join(DATA_DIR, "team_profiles.json");
const AUDITS_FILE = path.join(DATA_DIR, "audits_history.json");
const ACCESS_COOKIE = "aiv_access";
const REFRESH_COOKIE = "aiv_refresh";

const DELETION_LOG_FILE = path.join(
  DATA_DIR,
  "account-deletions.json"
);
// ────────────────────────────────────────────────────────────────────────────

const protectedPaths = new Set([
  "/community",
  "/community.html",
  "/support-page",
  "/support-page/",
  "/support-page/index.html",
]);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".php": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

async function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  try {
    const raw = await fs.readFile(envPath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) return;

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) return cookies;
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
    return cookies;
  }, {});
}

function authCookies(token, req) {
  const secure = req.headers["x-forwarded-proto"] === "https";
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearAuthCookies() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

let db = null;
let useFirestore = false;

async function getUserByEmail(email) {
  if (!useFirestore) {
    const users = await readUsers();
    return users.find((u) => u.email === email) || null;
  }
  const snapshot = await db
    .collection(COLLECTIONS.USERS)
    .where("email", "==", email)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return { ...snapshot.docs[0].data(), id: snapshot.docs[0].id };
}

async function createUser(userData) {
  if (!useFirestore) {
    const users = await readUsers();
    users.push(userData);
    await writeUsers(users);
    return userData;
  }
  const docRef = await db.collection(COLLECTIONS.USERS).add(userData);
  return { ...userData, id: docRef.id };
}

async function ensureUserStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(USERS_FILE);
  } catch {
    await fs.writeFile(USERS_FILE, "[]\n");
  }
}

async function readUsers() {
  await ensureUserStore();
  const raw = await fs.readFile(USERS_FILE, "utf8");
  return JSON.parse(raw || "[]");
}

async function writeUsers(users) {
  await ensureUserStore();
  await fs.writeFile(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`);
}

async function ensureAuditsStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(AUDITS_FILE);
  } catch {
    await fs.writeFile(AUDITS_FILE, "[]\n");
  }
}

async function readAudits() {
  await ensureAuditsStore();
  const raw = await fs.readFile(AUDITS_FILE, "utf8");
  return JSON.parse(raw || "[]");
}

async function writeAudits(audits) {
  await ensureAuditsStore();
  await fs.writeFile(AUDITS_FILE, `${JSON.stringify(audits, null, 2)}\n`);
}

// ── Memory Scanner (Spaced Repetition, SM-2) ─────────────────────────────────
// NOTE: This currently uses local JSON file storage, matching the existing
// users.json/feedback.json pattern in this codebase. In multi-instance or
// serverless (VERCEL=1 / Firestore) deployments this is not a shared source
// of truth. Migrating to Firestore (mirroring getUserByEmail/createUser's
// useFirestore branching) is tracked as a follow-up.
let memoryWriteQueue = Promise.resolve();

async function ensureMemoryStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(MEMORY_FILE);
  } catch {
    await fs.writeFile(MEMORY_FILE, "{}\n");
  }
}

async function readMemoryStore() {
  await ensureMemoryStore();
  const raw = await fs.readFile(MEMORY_FILE, "utf8");
  return JSON.parse(raw || "{}");
}

async function writeMemoryStoreAtomic(filePath, store) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`);
  await fs.rename(tmpPath, filePath);
}

// Serializes read-modify-write cycles so concurrent /api/memory/* requests
// cannot clobber each other's updates. `mutator` receives the current store
// and must return the updated store.
async function updateMemoryStore(mutator) {
  const task = memoryWriteQueue.then(async () => {
    await ensureMemoryStore();
    const raw = await fs.readFile(MEMORY_FILE, "utf8");
    const store = JSON.parse(raw || "{}");
    const updated = await mutator(store);
    await writeMemoryStoreAtomic(MEMORY_FILE, store);
    return updated;
  });

  // Prevent one rejected task from permanently breaking the queue.
  memoryWriteQueue = task.catch(() => {});
  return task;
}

let teamProfilesWriteQueue = Promise.resolve();

async function ensureTeamProfilesStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(TEAM_PROFILES_FILE);
  } catch {
    await fs.writeFile(TEAM_PROFILES_FILE, "{}\n");
  }
}

async function readTeamProfilesStore() {
  await ensureTeamProfilesStore();
  const raw = await fs.readFile(TEAM_PROFILES_FILE, "utf8");
  return JSON.parse(raw || "{}");
}

async function writeTeamProfilesStoreAtomic(filePath, store) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`);
  await fs.rename(tmpPath, filePath);
}

async function updateTeamProfilesStore(mutator) {
  const task = teamProfilesWriteQueue.then(async () => {
    await ensureTeamProfilesStore();
    const raw = await fs.readFile(TEAM_PROFILES_FILE, "utf8");
    const store = JSON.parse(raw || "{}");
    const updated = await mutator(store);
    await writeTeamProfilesStoreAtomic(TEAM_PROFILES_FILE, store);
    return updated;
  });

  teamProfilesWriteQueue = task.catch((err) => {
    console.error("[updateTeamProfilesStore] Write task failed:", err);
  });
  return task;
}

// ──────────────────────────────────────────────────────────────────────────

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024)
      throw new Error("Request body is too large.");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, body, headers = {}) {
  // Note: COOP header omitted to allow Firebase signInWithPopup to access popup.closed
  // when opening cross-origin OAuth popups (Google, etc.)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return verifySessionToken(cookies[SESSION_COOKIE]);
}

function normalizePathname(pathname) {
  if (!pathname) return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

function isProtectedRoute(pathname) {
  return protectedPaths.has(pathname);
}

function authorizeRequest(req, pathname) {
  if (!isProtectedRoute(pathname)) {
    return { authorized: true };
  }

  const session = getSession(req);

  if (!session) {
    return {
      authorized: false,
      redirectTo: `/login?next=${encodeURIComponent(pathname)}`,
    };
  }

  return {
    authorized: true,
    session,
  };
}

function validateRequest(req) {
  const allowedMethods = ["GET", "POST"];
  if (!allowedMethods.includes(req.method)) {
    return {
      valid: false,
      status: 405,
      message: "Method not allowed.",
    };
  }

  return { valid: true };
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/log-error" && req.method === "POST") {
    try {
      const payload = await readJsonBody(req);
      const logFile = path.join(DATA_DIR, "client_errors.json");
      await fs.mkdir(DATA_DIR, { recursive: true });
      let currentLogs = [];
      try {
        const raw = await fs.readFile(logFile, "utf8");
        currentLogs = JSON.parse(raw || "[]");
      } catch (e) {
        // file might not exist
      }
      currentLogs.push(payload);
      await fs.writeFile(logFile, `${JSON.stringify(currentLogs, null, 2)}\n`);
      return sendJson(res, 200, { success: true });
    } catch (err) {
      console.error("Error logging client error:", err);
      return sendJson(res, 500, { error: "Failed to log error" });
    }
  }

  if (pathname === "/api/team-profile" && req.method === "GET") {
    try {
      const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
      const teamId = urlParams.get("id");
      
      if (!teamId) {
        return sendJson(res, 400, { error: "Missing team id." });
      }

      let profileData = null;

      if (!useFirestore) {
        const store = await readTeamProfilesStore();
        profileData = store[teamId] || null;
      } else {
        const docRef = db.collection(COLLECTIONS.TEAM_PROFILES).doc(teamId);
        const snapshot = await docRef.get();
        if (snapshot.exists) {
          profileData = snapshot.data();
        }
      }

      if (!profileData) {
        // Return default profile with version 1
        return sendJson(res, 200, {
          id: teamId,
          version: 1,
          name: "New Team Profile",
          description: "",
          members: []
        });
      }

      return sendJson(res, 200, profileData);
    } catch (error) {
      console.error("Fetch team profile error:", error);
      return sendJson(res, 500, { error: "Failed to fetch team profile." });
    }
  }

  if (pathname === "/api/team-profile" && req.method === "POST") {
    try {
      const payload = await readJsonBody(req);
      const { id: teamId, version, name, description, members } = payload;

      if (!teamId) {
        return sendJson(res, 400, { error: "Missing team id." });
      }

      if (version === undefined || version === null) {
        return sendJson(res, 400, { error: "Missing version for concurrency control." });
      }

      let updatedProfile = null;

      if (!useFirestore) {
        try {
          updatedProfile = await updateTeamProfilesStore(store => {
            const currentProfile = store[teamId] || { version: 1 };
            
            // OCC version check
            if (currentProfile.version !== version) {
              const conflictError = new Error("Conflict");
              conflictError.status = 409;
              conflictError.currentVersion = currentProfile.version;
              throw conflictError;
            }

            // Update data and increment version
            const newProfile = {
              id: teamId,
              name: name || currentProfile.name || "New Team Profile",
              description: description !== undefined ? description : (currentProfile.description || ""),
              members: members || currentProfile.members || [],
              version: version + 1,
              updatedAt: new Date().toISOString()
            };

            store[teamId] = newProfile;
            return newProfile;
          });
        } catch (error) {
          if (error.status === 409) {
            return sendJson(res, 409, { 
              error: "Conflict detected: The profile was updated by someone else.",
              currentVersion: error.currentVersion
            });
          }
          throw error;
        }
      } else {
        const docRef = db.collection(COLLECTIONS.TEAM_PROFILES).doc(teamId);
        try {
          updatedProfile = await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(docRef);
            
            const currentVersion = doc.exists ? doc.data().version : 1;

            if (currentVersion !== version) {
              const conflictError = new Error("Conflict");
              conflictError.status = 409;
              conflictError.currentVersion = currentVersion;
              throw conflictError;
            }

            const newProfile = {
              id: teamId,
              name: name || (doc.exists ? doc.data().name : "New Team Profile"),
              description: description !== undefined ? description : (doc.exists ? doc.data().description : ""),
              members: members || (doc.exists ? doc.data().members : []),
              version: version + 1,
              updatedAt: new Date().toISOString()
            };

            transaction.set(docRef, newProfile);
            return newProfile;
          });
        } catch (error) {
          if (error.status === 409) {
            return sendJson(res, 409, { 
              error: "Conflict detected: The profile was updated by someone else.",
              currentVersion: error.currentVersion
            });
          }
          throw error;
        }
      }

      return sendJson(res, 200, updatedProfile);
    } catch (error) {
      console.error("Update team profile error:", error);
      return sendJson(res, 500, { error: "Failed to update team profile." });
    }
  }

  if (
    pathname === "/api/debug-env" &&
    req.method === "GET" &&
    process.env.NODE_ENV !== "production"
  ) {
    const keys = ["FIREBASE_API_KEY","FIREBASE_AUTH_DOMAIN","FIREBASE_PROJECT_ID","FIREBASE_STORAGE_BUCKET","FIREBASE_MESSAGING_SENDER_ID","FIREBASE_APP_ID","FIREBASE_CLIENT_EMAIL","FIREBASE_PRIVATE_KEY","SESSION_SECRET"];
    const vars = {};
    keys.forEach(k => {
      const v = process.env[k];
      vars[k] = v ? v.slice(0, 6) + "..." + v.slice(-4) : "(not set)";
    });
    return sendJson(res, 200, vars);
  }
  if (pathname === "/api/firebase-config" && req.method === "GET") {
    const apiKey = process.env.FIREBASE_API_KEY;
    const authDomain = process.env.FIREBASE_AUTH_DOMAIN;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
    const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID;
    const appId = process.env.FIREBASE_APP_ID;

    if (!apiKey || !authDomain || !projectId || !storageBucket || !messagingSenderId || !appId) {
      return sendJson(res, 503, { configured: false, error: "Firebase not configured" });
    }

    return sendJson(res, 200, {
      configured: true,
      apiKey,
      authDomain,
      projectId,
      storageBucket,
      messagingSenderId,
      appId,
    });
  }

  if (pathname === "/api/analyze-resume" && req.method === "POST") {
    try {
      await new Promise((resolve, reject) => {
        upload(req, res, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      if (!req.file) {
        return sendJson(res, 400, { error: "No resume file uploaded." });
      }

      const text = await extractResumeText(req.file);
      const atsScore = calculateATS(text);
      const missingSkills = findMissingSkills(text);
      const suggestions = getSuggestions(atsScore);

      return sendJson(res, 200, {
        atsScore,
        missingSkills,
        suggestions,
      });
    } catch (error) {
      console.error("Resume analysis error:", error);
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        return sendJson(res, 413, { error: "Resume file is too large." });
      }
      if (error?.message === "Unsupported file") {
        return sendJson(res, 400, { error: "Unsupported file type. Upload PDF or DOCX." });
      }
      return sendJson(res, 500, { error: "Failed to analyze resume." });
    }
  }

  if (pathname === "/api/analyze-repository" && req.method === "POST") {
    try {
      const payload = await readJsonBody(req);
      const { repoUrl } = payload;
      
      if (!repoUrl || !repoUrl.includes("github.com")) {
        return sendJson(res, 400, { error: "Please provide a valid GitHub repository URL." });
      }

      const provider = VCSFactory.getProvider(repoUrl);
      const workflows = await provider.getNormalizedWorkflows();
      
      if (workflows.length === 0) {
        return sendJson(res, 200, {
          score: 0,
          workflowsAnalyzed: 0,
          details: { hasDependencies: false, hasTests: false },
          recommendations: ["No GitHub Actions workflows found in .github/workflows. Add a CI/CD pipeline to automate testing."]
        });
      }

      let bestScore = -1;
      let overallDeps = false;
      let overallTests = false;

      for (const wf of workflows) {
        const result = analyzeWorkflow(wf.commands);
        if (result.score > bestScore) bestScore = result.score;
        if (result.hasDependencies) overallDeps = true;
        if (result.hasTests) overallTests = true;
      }

      const recommendations = [];
      if (bestScore === 20) recommendations.push("Workflows found, but they contain no functional jobs or steps.");
      if (bestScore === 50) recommendations.push("Add explicit testing commands (like 'npm test') to your workflow.");
      if (bestScore === 75) recommendations.push("Ensure dependencies are installed securely before running tests.");
      if (bestScore === 100) recommendations.push("Excellent! Fully functional CI/CD pipeline detected.");

      return sendJson(res, 200, {
        score: bestScore,
        workflowsAnalyzed: workflows.length,
        details: {
          hasDependencies: overallDeps,
          hasTests: overallTests
        },
        recommendations
      });

    } catch (err) {
      console.error("Repository analysis error:", err.message);
      return sendJson(res, 500, { error: "Failed to analyze repository. " + err.message });
    }
  }

  // Bulk Audit APIs
  if (pathname === "/api/audit/bulk" && req.method === "POST") {
    try {
      uploadCsv(req, res, async (err) => {
        if (err) return sendJson(res, 500, { error: "Upload error." });
        if (!req.file) return sendJson(res, 400, { error: "No CSV file uploaded." });
        
        try {
          const records = csvParse(req.file.buffer.toString('utf-8'), { columns: false, skip_empty_lines: true });
          // Extract repo URLs from the first column
          const repoUrls = records.map(row => row[0]).filter(url => url && url.includes("github.com"));
          
          if (repoUrls.length === 0) {
            return sendJson(res, 400, { error: "No valid GitHub URLs found in the CSV." });
          }

          const batchId = uuidv4();
          await enqueueBulkAudit(batchId, repoUrls);

          return sendJson(res, 202, {
            message: "Bulk audit accepted and queued.",
            batchId,
            totalJobs: repoUrls.length
          });
        } catch (parseErr) {
          console.error("CSV Parse Error:", parseErr);
          return sendJson(res, 400, { error: "Failed to parse CSV file." });
        }
      });
      return; // Async multer
    } catch (err) {
      return sendJson(res, 500, { error: "Failed to queue bulk audit." });
    }
  }

  if (pathname.startsWith("/api/audit/bulk/") && req.method === "GET") {
    const batchId = pathname.split("/").pop();
    const progress = getBatchProgress(batchId);
    if (!progress) {
      return sendJson(res, 404, { error: "Batch not found." });
    }
    return sendJson(res, 200, progress);
  }


  if (pathname === "/api/logout" && req.method === "POST") {
    const rToken = getRefreshToken(req);
    if (rToken) {
      const decoded = verifyRefreshToken(rToken);
      if (decoded) revokeTokenFamily(decoded.familyId);
    }
    return sendJson(res, 200, { success: true }, { "Set-Cookie": clearAuthCookies() });
  }

  if (pathname === "/api/refresh" && req.method === "POST") {
    const rToken = getRefreshToken(req);
    if (!rToken) return sendJson(res, 401, { error: "No refresh token" });
    
    const decoded = verifyRefreshToken(rToken);
    if (!decoded) return sendJson(res, 401, { error: "Invalid or expired refresh token" }, { "Set-Cookie": clearAuthCookies() });
    revokeTokenFamily(decoded.familyId);

    // Find user
    const users = useFirestore ? [] : await readUsers();
    let user;
    if (useFirestore) {
      user = await getUserByEmail(decoded.email);
      if (!user) {
        try {
          const snapshot = await db.collection("users").doc(decoded.sub).get();
          if (snapshot.exists) user = { ...snapshot.data(), id: snapshot.id };
        } catch(e) {}
      }
    } else {
      user = users.find(u => u.id === decoded.sub);
    }

    if (!user) return sendJson(res, 401, { error: "User not found" }, { "Set-Cookie": clearAuthCookies() });

    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user, decoded.familyId);
    
    return sendJson(res, 200, { success: true }, { "Set-Cookie": authCookies(accessToken, refreshToken, req) });
  }

  if (pathname === "/api/session" && req.method === "GET") {
    const session = getSession(req);
    return sendJson(res, 200, {
      authenticated: Boolean(session),
      user: session,
    });
  }

  if (pathname === "/api/signup" && req.method === "POST") {
    const clientId = getClientIdentifier(req);
    if (isSignupRateLimited(clientId)) {
      await normalizeAuthDelay();
      return sendJson(res, 429, { error: "Too many signup attempts. Please try again later." });
    }
    recordSignupAttempt(clientId);

    const payload = await readJsonBody(req);
    const validationError = validateSignup(payload);
    if (validationError) return sendJson(res, 400, { error: validationError });

    const email = String(payload.email).trim().toLowerCase();
    const existing = await getUserByEmail(email);
    if (existing) {
      await normalizeAuthDelay();
      return sendJson(res, 200, { ok: true });
    }

    const verifyToken = crypto.randomBytes(32).toString("hex");
    const user = {
      id: crypto.randomUUID(),
      name: String(payload.name).trim(),
      email,
      password: hashPassword(String(payload.password)),
      createdAt: new Date().toISOString(),
      isDeactivated: false,
      deactivatedAt: null,
      emailVerified: false,
      verifyToken,
      verifyTokenExpiry: Date.now() + 24 * 60 * 60 * 1000,
    };
    try {
      await createUser(user);
    } catch (createError) {
      console.error("Signup user creation failed:", createError);
      return sendJson(res, 500, { error: "Failed to create user account." });
    }

    sendVerificationEmail(user.email, user.name, verifyToken).catch((err) =>
      console.error("[email] Failed to send verification email:", err)
    );

    return sendJson(res, 200, {
      ok: true,
      requiresVerification: true,
      email: user.email,
    });
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const email = String(payload.email || "").trim().toLowerCase();
    const password = String(payload.password || "");
    const user = await getUserByEmail(email);
    if (!user || !passwordMatches(password, user.password)) {
      return sendJson(res, 401, { error: "Invalid email or password." });
    }

    if (!user.emailVerified) {
      return sendJson(res, 403, {
        error: "Please verify your email before logging in.",
        requiresVerification: true,
        email: user.email,
      });
    }

    if (user.isDeactivated) {
      user.isDeactivated = false;
      user.deactivatedAt = null;
      const users = await readUsers();
      const index = users.findIndex((u) => u.id === user.id);
      if (index !== -1) { users[index] = user; await writeUsers(users); }
    }

    const token = createSessionToken(user);
    return sendJson(
      res, 200,
      { user: { id: user.id, name: user.name, email: user.email } },
      { "Set-Cookie": authCookies(token, req) },
    );
  }

  if (pathname === "/api/auth/google" && req.method === "POST") {
    if (!process.env.FIREBASE_PROJECT_ID) {
      return sendJson(res, 500, { error: "Firebase is not configured for authentication. Set FIREBASE_PROJECT_ID environment variable." });
    }

    try {
      const body = await readJsonBody(req);
      const { idToken } = body;
      if (!idToken) {
        return sendJson(res, 400, { error: "Missing idToken" });
      }

      let decoded;
      try {
        const apiKey = process.env.FIREBASE_API_KEY;
        if (!apiKey) throw new Error("FIREBASE_API_KEY not configured");

        const tokenResponse = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken }),
          }
        );

        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          throw new Error(`Lookup failed: ${tokenResponse.status} ${errText}`);
        }

        const tokenData = await tokenResponse.json();
        if (!tokenData.users || tokenData.users.length === 0) throw new Error("No user found for token");

        const u = tokenData.users[0];
        decoded = {
          uid: u.localId,
          email: u.email,
          name: u.displayName || u.email,
          picture: u.photoUrl || null,
          emailVerified: u.emailVerified === true,
        };
      } catch (verifyError) {
        console.error("Token verification failed:", verifyError.message);
        return sendJson(res, 401, { error: "Invalid token" });
      }

      const { uid, email, name, picture } = decoded;
      const cleanEmail = (email || "").toLowerCase().trim();
      const displayName = name || cleanEmail.split("@")[0] || "Learner";

      let user = null;
      if (!useFirestore) {
        return sendJson(res, 503, { error: "User accounts require Firebase Firestore in serverless mode. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY environment variables." });
      }
      const snapshot = await db
        .collection(COLLECTIONS.USERS)
        .where("firebaseUid", "==", uid)
        .limit(1)
        .get();
      if (!snapshot.empty) {
        user = { ...snapshot.docs[0].data(), id: snapshot.docs[0].id };
      } else {
        const emailSnapshot = await db
          .collection(COLLECTIONS.USERS)
          .where("email", "==", cleanEmail)
          .limit(1)
          .get();
        if (!emailSnapshot.empty) {
          user = { ...emailSnapshot.docs[0].data(), id: emailSnapshot.docs[0].id };
        }
      }

      if (user) {
        user.name = displayName;
        user.avatar = picture || user.avatar;
        user.lastLogin = new Date().toISOString();
        if (!user.firebaseUid) user.firebaseUid = uid;
        if (!user.authProvider) user.authProvider = "google";
        await db.collection(COLLECTIONS.USERS).doc(user.id).update({
          name: displayName, avatar: picture || null,
          lastLogin: new Date().toISOString(),
          firebaseUid: uid, authProvider: "google",
        });
      } else {
        const newUser = {
          id: uid, name: displayName, email: cleanEmail,
          avatar: picture || null, firebaseUid: uid,
          authProvider: "google",
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
        };
        user = await createUser(newUser);
      }

      const token = createSessionToken(user);
      const cookie = authCookies(token, req);

      return sendJson(res, 200, {
        authenticated: true,
        user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar },
      }, { "Set-Cookie": cookie });

    } catch (error) {
      console.error("Google auth error:", error.message || error);
      return sendJson(res, 500, { error: "Internal server error" });
    }
  }

  if (pathname === "/api/change-password" && req.method === "POST") {
  const session = getSession(req);

  if (!session) {
    return sendJson(res, 401, {
      error: "Login required.",
    });
  }

  const {
    currentPassword,
    newPassword,
    confirmPassword,
  } = await readJsonBody(req);

  if (
    !currentPassword ||
    !newPassword ||
    !confirmPassword
  ) {
    return sendJson(res, 400, {
      error: "All fields are required.",
    });
  }

  if (newPassword !== confirmPassword) {
    return sendJson(res, 400, {
      error: "Passwords do not match.",
    });
  }

  if (newPassword.length < 8) {
    return sendJson(res, 400, {
      error:
        "Password must be at least 8 characters.",
    });
  }

  if (
    !/[A-Z]/.test(newPassword) ||
    !/[a-z]/.test(newPassword) ||
    !/\d/.test(newPassword)
  ) {
    return sendJson(res, 400, {
      error:
        "Password must contain uppercase, lowercase and number.",
    });
  }

  const users = await readUsers();

  const user = users.find(
    (u) => u.id === session.sub
  );

  if (!user) {
    return sendJson(res, 404, {
      error: "User not found.",
    });
  }

  if (
    !passwordMatches(
      currentPassword,
      user.password
    )
  ) {
    return sendJson(res, 400, {
      error: "Current password is incorrect.",
    });
  }

  user.password = hashPassword(newPassword);

  await writeUsers(users);

  return sendJson(
    res,
    200,
    {
      success: true,
      message:
        "Password updated successfully.",
    },
    {
      "Set-Cookie": clearAuthCookies(),
    }
  );
}

  if (pathname === "/api/deactivate-account" && req.method === "POST") {
  const session = getSession(req);

  if (!session) {
    return sendJson(res, 401, {
      error: "Login required.",
    });
  }

  const users = await readUsers();

  const user = users.find((u) => u.id === session.sub);

  if (!user) {
    return sendJson(res, 404, {
      error: "User not found.",
    });
  }

  user.isDeactivated = true;
  user.deactivatedAt = new Date().toISOString();

  await writeUsers(users);

  return sendJson(
    res,
    200,
    { success: true },
    {
      "Set-Cookie": clearAuthCookies(),
    },
  );
}

if (
  pathname === "/api/delete-account" &&
  req.method === "POST"
) {
  const session = getSession(req);

  if (!session) {
    return sendJson(res, 401, {
      error: "Login required.",
    });
  }

  const payload = await readJsonBody(req);

  const password = String(
    payload.password || ""
  );

  const users = await readUsers();

  const userIndex = users.findIndex(
    (u) => u.id === session.sub
  );

  if (userIndex === -1) {
    return sendJson(res, 404, {
      error: "User not found.",
    });
  }

  const user = users[userIndex];

  if (
    !passwordMatches(
      password,
      user.password
    )
  ) {
    return sendJson(res, 401, {
      error: "Incorrect password.",
    });
  }

  // Log deletion event
  const deletionEvent = {
    userId: user.id,
    email: user.email,
    deletedAt: new Date().toISOString(),
  };

  let logs = [];

  try {
    const raw = await fs.readFile(
      DELETION_LOG_FILE,
      "utf8"
    );

    logs = JSON.parse(raw || "[]");
  } catch {}

  logs.push(deletionEvent);

  await fs.writeFile(
    DELETION_LOG_FILE,
    JSON.stringify(logs, null, 2)
  );

  // Remove user
  users.splice(userIndex, 1);

  await writeUsers(users);

  return sendJson(
    res,
    200,
    {
      success: true,
    },
    {
      "Set-Cookie":
        clearAuthCookies(),
    }
  );
}
if (pathname === "/api/forgot-password" && req.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body." });
    }

    const email = String(payload.email || "").trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, { error: "Valid email required." });
    }

    try {
      const { initializeApp, getApps } = await import("firebase/app");
      const { getAuth, sendPasswordResetEmail } = await import("firebase/auth");

      const configRes = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/firebase-config`);
      const firebaseConfig = await configRes.json();

      if (firebaseConfig.configured) {
        const existingApps = getApps();
        const clientApp = existingApps.find(a => a.name === "reset-client") ||
          initializeApp({
            apiKey: firebaseConfig.apiKey,
            authDomain: firebaseConfig.authDomain,
            projectId: firebaseConfig.projectId,
          }, "reset-client");

        const auth = getAuth(clientApp);
        await sendPasswordResetEmail(auth, email);
      }
    } catch (err) {
      // Silently fail — don't expose whether email exists
      console.warn("[forgot-password]", err.message);
    }

    // Always return success to prevent email enumeration
    return sendJson(res, 200, { message: "Reset email sent if account exists." });
  }
  if (pathname === "/api/logout" && req.method === "POST") {
    return sendJson(
      res,
      200,
      { ok: true },
      { "Set-Cookie": clearAuthCookies() },
    );
  }

  if (pathname === "/api/feedback" && req.method === "POST") {
    const session = getSession(req);
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: "Invalid JSON body." });
    }

    const { feedbackType, subject, message } = payload;
    if (!feedbackType || !subject || !message) {
      return sendJson(res, 400, {
        error: "Feedback type, subject, and message are required.",
      });
    }

    const allowedTypes = [
      "Suggestion",
      "Bug Report",
      "Feature Request",
      "General Feedback",
    ];
    if (!allowedTypes.includes(feedbackType)) {
      return sendJson(res, 400, { error: "Invalid feedback type." });
    }

    if (subject.trim().length < 3) {
      return sendJson(res, 400, {
        error: "Subject must be at least 3 characters long.",
      });
    }

    if (message.trim().length < 10) {
      return sendJson(res, 400, {
        error: "Message must be at least 10 characters long.",
      });
    }

    const feedbackData = {
      userId: session ? session.sub : null,
      userName: session ? session.name : null,
      userEmail: session ? session.email : null,
      feedbackType,
      subject: subject.trim(),
      message: message.trim(),
      status: "new",
      createdAt: new Date().toISOString(),
    };

    try {
      if (useFirestore) {
        const docRef = await db.collection("feedback").add(feedbackData);
        feedbackData.id = docRef.id;
      } else {
        const feedbackFile = path.join(DATA_DIR, "feedback.json");
        await fs.mkdir(DATA_DIR, { recursive: true });
        let feedbackList = [];
        try {
          const raw = await fs.readFile(feedbackFile, "utf8");
          feedbackList = JSON.parse(raw || "[]");
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
        feedbackData.id = crypto.randomUUID();
        feedbackList.push(feedbackData);
        await fs.writeFile(
          feedbackFile,
          JSON.stringify(feedbackList, null, 2) + "\n",
        );
      }

      return sendJson(res, 201, { success: true, feedback: feedbackData });
    } catch (err) {
      console.error("Error saving feedback:", err);
      return sendJson(res, 500, { error: "Failed to save feedback." });
    }
  }

  if (pathname === "/api/interview-experiences" && req.method === "POST") {
    const session = getSession(req);
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body." });
    }

    const {
      company,
      role,
      difficulty,
      rating,
      title,
      content,
      topics,
      rounds,
      offerStatus,
    } = payload;
    if (!company || !role || !difficulty || !rating || !title || !content) {
      return sendJson(res, 400, {
        error:
          "Company, role, difficulty, rating, title, and content are required.",
      });
    }

    const experienceData = {
      id: crypto.randomUUID(),
      userId: session ? session.sub : null,
      userName: session ? session.name : null,
      company: company.trim(),
      role: role.trim(),
      difficulty,
      rating,
      title: title.trim(),
      content: content.trim(),
      topics: Array.isArray(topics) ? topics : [],
      rounds: rounds || null,
      offerStatus: offerStatus || null,
      upvotes: 0,
      createdAt: new Date().toISOString(),
    };

    try {
      if (useFirestore) {
        const docRef = await db
          .collection("interviewExperiences")
          .add(experienceData);
        experienceData.id = docRef.id;
      } else {
        const filePath = path.join(DATA_DIR, "interview-experiences.json");
        await fs.mkdir(DATA_DIR, { recursive: true });
        let list = [];
        try {
          const raw = await fs.readFile(filePath, "utf8");
          list = JSON.parse(raw || "[]");
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
        list.push(experienceData);
        await fs.writeFile(filePath, JSON.stringify(list, null, 2) + "\n");
      }
      return sendJson(res, 201, { success: true, experience: experienceData });
    } catch (err) {
      console.error("Error saving interview experience:", err);
      return sendJson(res, 500, {
        error: "Failed to save interview experience.",
      });
    }
  }

  if (pathname === "/api/audit/history" && req.method === "POST") {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Login required." });

    try {
      const payload = await readJsonBody(req);
      const auditData = {
        auditId: crypto.randomUUID(),
        userId: session.sub,
        repoUrl: payload.repoUrl || "unknown",
        timestamp: new Date().toISOString(),
        overallScore: Number(payload.overallScore) || 0,
        categoryScores: payload.categoryScores || {},
        issuesCount: Number(payload.issuesCount) || 0,
        recommendations: payload.recommendations || []
      };

      if (useFirestore) {
        await db.collection(COLLECTIONS.AUDITS_HISTORY).doc(auditData.auditId).set(auditData);
      } else {
        const audits = await readAudits();
        audits.push(auditData);
        await writeAudits(audits);
      }

      return sendJson(res, 201, { success: true, auditId: auditData.auditId });
    } catch (err) {
      console.error("Error saving audit history:", err);
      return sendJson(res, 500, { error: "Failed to save audit history." });
    }
  }

  if (pathname === "/api/audit/history" && req.method === "GET") {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Login required." });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const repoUrl = url.searchParams.get("repoUrl");
    const limit = Number(url.searchParams.get("limit")) || 20;

    try {
      let history = [];
      if (useFirestore) {
        let query = db.collection(COLLECTIONS.AUDITS_HISTORY)
          .where("userId", "==", session.sub);
        
        if (repoUrl) {
          query = query.where("repoUrl", "==", repoUrl);
        }
        
        const snapshot = await query.orderBy("timestamp", "desc").limit(limit).get();
        history = snapshot.docs.map(doc => doc.data());
      } else {
        const allAudits = await readAudits();
        history = allAudits.filter(a => a.userId === session.sub);
        if (repoUrl) {
          history = history.filter(a => a.repoUrl === repoUrl);
        }
        history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        history = history.slice(0, limit);
      }

      return sendJson(res, 200, history);
    } catch (err) {
      console.error("Error fetching audit history:", err);
      return sendJson(res, 500, { error: "Failed to fetch audit history." });
    }
  }

  if (pathname === "/api/audit/trends" && req.method === "GET") {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Login required." });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const repoUrl = url.searchParams.get("repoUrl");

    try {
      let history = [];
      if (useFirestore) {
        let query = db.collection(COLLECTIONS.AUDITS_HISTORY)
          .where("userId", "==", session.sub);
        if (repoUrl) query = query.where("repoUrl", "==", repoUrl);
        const snapshot = await query.orderBy("timestamp", "asc").get();
        history = snapshot.docs.map(doc => doc.data());
      } else {
        const allAudits = await readAudits();
        history = allAudits.filter(a => a.userId === session.sub);
        if (repoUrl) history = history.filter(a => a.repoUrl === repoUrl);
        history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      }

      const trends = history.map(a => ({
        timestamp: a.timestamp,
        overallScore: a.overallScore
      }));

      return sendJson(res, 200, trends);
    } catch (err) {
      console.error("Error fetching audit trends:", err);
      return sendJson(res, 500, { error: "Failed to fetch audit trends." });
    }
  }

  if (pathname === "/api/memory/log" && req.method === "POST") {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Login required." });

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body." });
    }

    const { topic, quality } = payload;
    if (!topic || typeof topic !== "string" || topic.trim().length < 1) {
      return sendJson(res, 400, { error: "Topic is required." });
    }
    if (
      quality === undefined ||
      isNaN(Number(quality)) ||
      Number(quality) < 0 ||
      Number(quality) > 5
    ) {
      return sendJson(res, 400, {
        error: "Quality must be a number between 0 and 5.",
      });
    }

    const trimmedTopic = topic.trim();
    const updatedCard = await updateMemoryStore((store) => {
      const userCards = store[session.sub] || {};
      const existing = userCards[trimmedTopic] || { topic: trimmedTopic };
      const updated = applySM2(existing, quality);
      userCards[trimmedTopic] = updated;
      store[session.sub] = userCards;
      return updated;
    });

    return sendJson(res, 200, { success: true, card: updatedCard });
  }

  if (pathname === "/api/memory/due" && req.method === "GET") {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Login required." });

    const store = await readMemoryStore();
    const userCards = store[session.sub] || {};
    const now = new Date();
    const due = Object.values(userCards).filter(
      (card) => new Date(card.nextReviewDate) <= now,
    );

    return sendJson(res, 200, { success: true, due });
  }

  if (pathname === "/api/memory/all" && req.method === "GET") {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Login required." });

    const store = await readMemoryStore();
    const userCards = store[session.sub] || {};

    return sendJson(res, 200, {
      success: true,
      cards: Object.values(userCards),
    });
  }

  // ── Quiz Results (Firestore) ──────────────────────────────────────────────
  if (pathname === "/api/quiz-results" && req.method === "POST") {
    const session = getSession(req);
    if (!session)
      return sendJson(res, 401, { error: "Authentication required." });
    if (!useFirestore)
      return sendJson(res, 503, { error: "User store unavailable." });

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body." });
    }

    const {
      quizId,
      quizTitle,
      score,
      totalQuestions,
      correctAnswers,
      percentage,
      topic,
    } = payload;
    if (
      !quizId ||
      !quizTitle ||
      score === undefined ||
      !totalQuestions ||
      correctAnswers === undefined ||
      percentage === undefined ||
      !topic
    ) {
      return sendJson(res, 400, {
        error:
          "Missing required fields: quizId, quizTitle, score, totalQuestions, correctAnswers, percentage, topic.",
      });
    }

    if (typeof score !== "number" || score < 0)
      return sendJson(res, 400, {
        error: "score must be a non-negative number.",
      });
    if (typeof totalQuestions !== "number" || totalQuestions < 1)
      return sendJson(res, 400, { error: "totalQuestions must be >= 1." });
    if (typeof correctAnswers !== "number" || correctAnswers < 0)
      return sendJson(res, 400, { error: "correctAnswers must be >= 0." });
    if (correctAnswers > totalQuestions)
      return sendJson(res, 400, {
        error: "correctAnswers cannot exceed totalQuestions.",
      });
    if (typeof percentage !== "number" || percentage < 0 || percentage > 100)
      return sendJson(res, 400, { error: "percentage must be 0-100." });

    try {
      const attemptId = crypto.randomUUID();
      const attempt = {
        quizId: String(quizId),
        quizTitle: String(quizTitle),
        score: Number(score),
        totalQuestions: Number(totalQuestions),
        correctAnswers: Number(correctAnswers),
        percentage: Number(percentage),
        topic: String(topic),
        completedAt: new Date().toISOString(),
      };

      await db
        .collection("users")
        .doc(session.sub)
        .collection("quizResults")
        .doc(attemptId)
        .set(attempt);

      return sendJson(res, 201, { success: true, attemptId, attempt });
    } catch (error) {
      console.error("Failed to save quiz result:", error);
      return sendJson(res, 500, { error: "Failed to save quiz result." });
    }
  }

  if (pathname === "/api/quiz-results" && req.method === "GET") {
    const session = getSession(req);
    if (!session)
      return sendJson(res, 401, { error: "Authentication required." });
    if (!useFirestore)
      return sendJson(res, 503, { error: "User store unavailable." });

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const parsedLimit = parseInt(url.searchParams.get("limit") || "20", 10);
      const limit = Math.min(Number.isNaN(parsedLimit) ? 20 : parsedLimit, 100);
      const topic = url.searchParams.get("topic");

      let query = db
        .collection("users")
        .doc(session.sub)
        .collection("quizResults")
        .orderBy("completedAt", "desc")
        .limit(limit);

      if (topic) {
        query = query.where("topic", "==", topic);
      }

      const snapshot = await query.get();
      const results = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      return sendJson(res, 200, {
        success: true,
        results,
        count: results.length,
      });
    } catch (error) {
      console.error("Failed to fetch quiz results:", error);
      return sendJson(res, 500, { error: "Failed to fetch quiz results." });
    }
  }

  if (pathname === "/api/reports/export/pdf" || pathname === "/api/reports/export/image") {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Authentication required." });
    return await handleReportRequest(req, res, pathname, session);
  }

  if (pathname === "/api/user/benchmark" && req.method === "GET") {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Authentication required." });
    
    try {
        const benchmark = await getUserBenchmark(session.sub);
        return sendJson(res, 200, { success: true, benchmark });
    } catch (err) {
        console.error("Benchmark error:", err);
        return sendJson(res, 500, { error: "Failed to generate benchmark." });
    }
  }

  // ── Battle routes ──────────────────────────────────────────────────────────
  // All battle routes require Firestore. If useFirestore is false (local dev
  // with no Firebase env vars), we return 503 rather than crashing.
  // All routes require an active session — unauthenticated requests get 401.
 
  if (pathname === "/api/battles" && req.method === "POST") {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Login required." });
    if (!useFirestore) return sendJson(res, 503, { error: "Battle mode requires Firestore." });
 
    try {
      const { opponentEmail, difficulty } = await readJsonBody(req);
      if (!opponentEmail?.trim()) {
        return sendJson(res, 400, { error: "opponentEmail is required." });
      }
      if (!["Easy", "Medium", "Hard"].includes(difficulty)) {
        return sendJson(res, 400, { error: "difficulty must be Easy, Medium, or Hard." });
      }
      const battleId = await createBattle(session.sub, opponentEmail.trim(), difficulty);
      return sendJson(res, 201, { battleId });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
 
  // GET /api/battles/history  — must be declared BEFORE the :id pattern below
  // or "history" gets captured as a battle ID.
  if (pathname === "/api/battles/history" && req.method === "GET") {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Login required." });
    if (!useFirestore) return sendJson(res, 503, { error: "Battle mode requires Firestore." });
 
    try {
      const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
      const limit      = Math.min(parseInt(params.get("limit") || "20", 10), 50);
      const startAfter = params.get("cursor") || null;
      const history = await getHistory(session.sub, limit, startAfter);
      return sendJson(res, 200, {
        history,
        nextCursor: history.length === limit ? history[history.length - 1].id : null,
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
 
  // Dynamic battle routes: /api/battles/:id and /api/battles/:id/(join|submit|result)
  const battleMatch = pathname.match(
    /^\/api\/battles\/([^/]+?)(?:\/(join|submit|result))?$/
  );
 
  if (battleMatch) {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Login required." });
    if (!useFirestore) return sendJson(res, 503, { error: "Battle mode requires Firestore." });
 
    const [, battleId, action] = battleMatch;
 
    // GET /api/battles/:id — poll endpoint, returns state + timeRemainingMs
    if (!action && req.method === "GET") {
      try {
        const battle = await getBattle(battleId);
        return sendJson(res, 200, battle);
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
    }
 
    // POST /api/battles/:id/join
    if (action === "join" && req.method === "POST") {
      try {
        const result = await joinBattle(battleId, session.sub);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
 
    // POST /api/battles/:id/submit
    if (action === "submit" && req.method === "POST") {
      try {
        const { code } = await readJsonBody(req);
        if (!code?.trim()) {
          return sendJson(res, 400, { error: "code is required." });
        }
        const result = await submitSolution(battleId, session.sub, code);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
 
    // GET /api/battles/:id/result
    if (action === "result" && req.method === "GET") {
      try {
        const battle = await getBattle(battleId);
        if (!["completed", "expired"].includes(battle.status)) {
          return sendJson(res, 409, { error: "Battle is not finished yet." });
        }
        return sendJson(res, 200, {
          winner:     battle.winner,
          xpAwarded:  battle.xpAwarded,
          status:     battle.status,
        });
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
    }
  }
  // ── End battle routes ─────

  if (pathname === "/api/verify-email" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) return sendJson(res, 400, { error: "Missing token." });

    const users = await readUsers();
    const idx = users.findIndex(
      (u) => u.verifyToken === token && u.verifyTokenExpiry > Date.now()
    );
    if (idx === -1) return sendJson(res, 400, { error: "Link is invalid or expired." });

    users[idx].emailVerified = true;
    users[idx].verifyToken = null;
    users[idx].verifyTokenExpiry = null;
    await writeUsers(users);

    const sessionToken = createSessionToken(users[idx]);
    res.setHeader("Set-Cookie", authCookies(sessionToken, req));
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/resend-verification" && req.method === "POST") {
    const body = await readJsonBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return sendJson(res, 400, { error: "Email required." });

    const users = await readUsers();
    const idx = users.findIndex((u) => u.email === email);
    if (idx === -1 || users[idx].emailVerified) return sendJson(res, 200, { ok: true });

    const newToken = crypto.randomBytes(32).toString("hex");
    users[idx].verifyToken = newToken;
    users[idx].verifyTokenExpiry = Date.now() + 24 * 60 * 60 * 1000;
    await writeUsers(users);

    sendVerificationEmail(email, users[idx].name, newToken).catch((err) =>
      console.error("[email] Resend failed:", err)
    );
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Not found." });
}

function resolveStaticPath(pathname) {
const routes = {
  "/": "index.html",
  "/login": "pages/auth/login.html",
  "/signup": "pages/auth/signup.html",
  "/verify-email": "pages/auth/verify-email.html",
    "/community": "community.html",
    "/python-learning": "python-learning.html",
    "/javascript-learning": "javascript-learning.html",
    "/dbms-learning": "dbms-learning.html",
    "/powerbi-learning": "powerbi-learning.html",
    "/cplusplus-learning": "cplusplus-learning.html",
    "/learning/php": "php-learning.html",
    "/php-learning": "php-learning.html",
    "/learning/oop": "oop-learning.html",
    "/oop-learning": "oop-learning.html",
    "/feedback": "feedback.html",
    "/feedback.html": "feedback.html",
    "/memory-scanner": "memory-scanner.html",
    "/memory-scanner.html": "memory-scanner.html",
    "/algorithm-timeline": "algorithm-timeline.html",
    "/support-page": "support-page/index.html",
    "/support-page/": "support-page/index.html",
  };
  let mapped = routes[pathname];
  if (!mapped) {
    const basePath = pathname.slice(1);
    mapped = path.extname(basePath) ? basePath : basePath + ".html";
  }
  const filePath = path.resolve(ROOT, mapped);
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

  // ── Arbitrary File Disclosure Prevention ──────────────────────────────────
  const fileName = path.basename(filePath);

  // 1. Block hidden files and sensitive directories
  if (
    fileName.startsWith(".") ||
    rel.startsWith("data" + path.sep) ||
    rel.startsWith("api" + path.sep) ||
    rel.startsWith("node_modules" + path.sep)
  ) {
    return null;
  }

  // 2. Block specific sensitive root files
  const sensitiveFiles = [
    "server.js",
    "firebase.js",
    "package.json",
    "package-lock.json",
    "vercel.json",
  ];
  if (sensitiveFiles.includes(fileName)) {
    return null;
  }

  // 3. Extension whitelist (only serve files with known mime types)
  const ext = path.extname(filePath);
  if (!mimeTypes[ext]) {
    return null;
  }
  // ──────────────────────────────────────────────────────────────────────────

  return filePath;
}

async function serveStatic(req, res, pathname) {
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const stat = await fs.stat(filePath);
    const target = stat.isDirectory()
      ? path.join(filePath, "index.html")
      : filePath;
    const ext = path.extname(target);
    const content = await fs.readFile(target);
    const headers = {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    };
    // Note: COOP header removed to allow Firebase signInWithPopup to access popup.closed
    // when opening cross-origin OAuth popups (Google, etc.)
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = normalizePathname(decodeURIComponent(url.pathname));

    const requestValidation = validateRequest(req);

    if (!requestValidation.valid) {
      return sendJson(res, requestValidation.status, {
        error: requestValidation.message,
      });
    }

    if (pathname.startsWith("/api/")) {
      return await handleApi(req, res, pathname);
    }

    if (pathname === "/logout") {
      return redirect(res, "/login", { "Set-Cookie": clearAuthCookies() });
    }

    const authorization = authorizeRequest(req, pathname);

    if (!authorization.authorized) {
      return redirect(res, authorization.redirectTo);
    }

    return await serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Something went wrong." });
  }
});

// --- PHASE 1 ADDITION: SOCKET.IO LOGIC ---
const io = new SocketIOServer(server);

io.on("connection", (socket) => {
console.log("🟢 New client connected:", socket.id);

 

// Draw events (whiteboard)
socket.on('draw', (data) => {
    // Broadcast to everyone else in the room
    socket.to(data.roomId).emit('receive-draw', data);
});

// Clear board
socket.on('clear-board', ({ roomId }) => {
    socket.to(roomId).emit('receive-clear');
});

// Shared notes
socket.on('share-notes', ({ roomId, text }) => {
    socket.to(roomId).emit('receive-notes', text);
});

// Chat messages
socket.on('chat-message', (data) => {
    socket.to(data.roomId).emit('chat-message', data);
});

// ── VOICE CHAT (WebRTC signaling) ──

socket.on('voice-join', ({ roomId, userId }) => {
    socket.to(roomId).emit('voice-user-joined', { userId });
});

socket.on('voice-leave', ({ roomId, userId }) => {
    socket.to(roomId).emit('voice-user-left', { userId });
});

// WebRTC offer
socket.on('voice-offer', ({ roomId, offer, to, from }) => {
    const targetSocketId = userSocketMap.get(to);
    if (targetSocketId) io.to(targetSocketId).emit('voice-offer', { offer, from });
});

socket.on('voice-answer', ({ roomId, answer, to, from }) => {
    const targetSocketId = userSocketMap.get(to);
    if (targetSocketId) io.to(targetSocketId).emit('voice-answer', { answer, from });
});

socket.on('voice-ice', ({ roomId, candidate, to, from }) => {
    const targetSocketId = userSocketMap.get(to);
    if (targetSocketId) io.to(targetSocketId).emit('voice-ice', { candidate, from });
});

// ── END OF ADDITIONS ──


  socket.on("join-room", (roomId, userId) => {
      socket.join(roomId);
      // Store user mapping
    userSocketMap.set(userId, socket.id);
    socket.userId = userId;
    socket.roomId = roomId;
     console.log(`👥 User ${userId} joined Room ${roomId}`);
      
      socket.to(roomId).emit("user-connected", userId);

      socket.on("disconnect", () => {
    if (socket.userId) {
        userSocketMap.delete(socket.userId);
        if (socket.roomId) {
            socket.to(socket.roomId).emit("user-disconnected", socket.userId);
        }
    }
});
  });
});
// -----------------------------------------

export { server, hashPassword, passwordMatches, applySM2, validateSignup };
if (process.env.VERCEL === "1") {
  db = initializeFirebase();
  useFirestore = !!db;
}



if (process.env.VERCEL !== "1" && process.env.NODE_ENV !== "test") {
  loadEnvFile()
    .then(() => {
      db = initializeFirebase();
      useFirestore = !!db;
      const port = Number(process.env.PORT || 3000);
      const host = process.env.HOST || "127.0.0.1";

      server.listen(port, host, () => {
        const url = `http://${host}:${port}`;
        console.log(`Server running at ${url}`);
        if (!process.env.SESSION_SECRET) {
          if (process.env.NODE_ENV === "production") {
            console.error("FATAL: SESSION_SECRET is required in production mode.");
            process.exit(1);
          }
          console.warn(
            "Using a development SESSION_SECRET. Set SESSION_SECRET before deploying.",
          );
        }
      });
    })
    .catch((error) => {
      console.error("Failed to load environment configuration:", error);
      process.exit(1);
    });
}

