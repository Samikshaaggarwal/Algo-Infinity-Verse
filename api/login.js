import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import crypto from "crypto";
import { verifyCsrfToken } from "../utils/csrf-verify.js"; // <-- ADDED CSRF IMPORT

let db = null;
let useFirestore = false;

function initFirebase() {
  if (getApps().length > 0) { db = getFirestore(); useFirestore = true; return; }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) { console.warn("Firebase credentials not set."); return; }
  try { initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }); db = getFirestore(); useFirestore = true; }
  catch (e) { console.error(e); }
}
initFirebase();

const SESSION_COOKIE = "aiv_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const PBKDF2_ITERATIONS = 600000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";

const PASSWORD_PEPPER = process.env.PASSWORD_PEPPER || "";

if (
  process.env.NODE_ENV === "production" &&
  !PASSWORD_PEPPER
) {
  throw new Error(
    "PASSWORD_PEPPER environment variable is required."
  );
}

const LOGIN_RATE_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production.");
  }
  return "dev-only-change-me-with-SESSION_SECRET-before-deploying";
}
function sign(v) { return crypto.createHmac("sha256", sessionSecret()).update(v).digest("base64url"); }
function b64u(i) { return Buffer.from(i).toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_"); }
function fromB64u(i) { return Buffer.from(i.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"); }
function createSessionToken(u) { const h=b64u(JSON.stringify({alg:"HS256",typ:"JWT"})); const p=b64u(JSON.stringify({sub:u.id,name:u.name,email:u.email,exp:Math.floor(Date.now()/1000)+SESSION_MAX_AGE_SECONDS})); return `${h}.${p}.${sign(`${h}.${p}`)}`; }
function isValidSalt(salt) {
  return (
    typeof salt === "string" &&
    /^[a-fA-F0-9]+$/.test(salt) &&
    salt.length === 32
  );
}
function passwordMatches(p, s) {

    if (!isValidSalt(s.salt)) {
        return false;
    }

    if (
        typeof s.hash !== "string" ||
        !/^[a-fA-F0-9]+$/.test(s.hash)
    ) {
        return false;
    }

    const computed = crypto.pbkdf2Sync(
        p + PASSWORD_PEPPER,
        s.salt,
        s.iterations || PBKDF2_ITERATIONS,
        PASSWORD_KEY_LENGTH,
        s.digest || PASSWORD_DIGEST
    );

    const stored = Buffer.from(
        s.hash,
        "hex"
    );

    return (
        stored.length === computed.length &&
        crypto.timingSafeEqual(
            stored,
            computed
        )
    );
}
function sessionCookie(t) { const sec=process.env.VERCEL==="1"; return [`${SESSION_COOKIE}=${encodeURIComponent(t)}`,"HttpOnly","SameSite=Lax","Path=/",`Max-Age=${SESSION_MAX_AGE_SECONDS}`,sec?"Secure":""].filter(Boolean).join("; "); }
function createRememberToken() { return crypto.randomBytes(32).toString("hex"); }

async function readUsers() { if(!useFirestore)return[]; try{const s=await db.collection("users").get();return s.docs.map(d=>({id:d.id,...d.data()}));}catch(e){console.error(e);return[];} }

async function storeRememberSession(user) {
  if (!useFirestore) return null;
  try {
    const token = createRememberToken();
    await db.collection("rememberSessions").doc(user.id).set({
      userId: user.id,
      name: user.name,
      email: user.email,
      token,
      exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
      createdAt: new Date().toISOString()
    });
    return token;
    } catch (e) { console.error(e); return null; }
}

function getClientIdentifier(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function isRateLimited(identifier) {
  const now = Date.now();
  const attempts = loginAttempts.get(identifier) || [];
  const recentAttempts = attempts.filter(
    (time) => now - time < LOGIN_WINDOW_MS
  );
  loginAttempts.set(identifier, recentAttempts);
  return recentAttempts.length >= LOGIN_RATE_LIMIT;
}

function recordLoginAttempt(identifier) {
  const attempts = loginAttempts.get(identifier) || [];
  attempts.push(Date.now());
  loginAttempts.set(identifier, attempts);
}

async function normalizeAuthDelay() {
  return new Promise((resolve) =>
    setTimeout(resolve, 500)
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  
  // --- ADDED SECURITY GATE: CSRF Validation ---
  if (!verifyCsrfToken(req)) {
      return res.status(403).json({ 
          error: "CSRF token validation failed. Unauthorized cross-site request detected." 
      });
  }
  // --------------------------------------------

  try {
    const {email,password}=req.body;
    const cleanEmail=String(email||"").trim().toLowerCase(),pwd=String(password||"");
    const clientId = getClientIdentifier(req);

    if (isRateLimited(clientId)) {
      await normalizeAuthDelay();
      return res.status(429).json({
        error: "Authentication failed.",
      });
    }
    const users=await readUsers();
    const user=users.find(u=>u.email===cleanEmail);
    if (!user || !passwordMatches(pwd, user.password)) {
      recordLoginAttempt(clientId);
      await normalizeAuthDelay();
      return res.status(401).json({
        error: "Authentication failed.",
      });
    }
    const token=createSessionToken(user);
    const rememberToken = await storeRememberSession(user);
    const headers = { "Set-Cookie": sessionCookie(token) };
    if (rememberToken) headers["X-Remember-Token"] = rememberToken;
    return res.status(200).set(headers).json({user:{id:user.id,name:user.name,email:user.email}});
  } catch(e){console.error(e);return res.status(500).json({error:"Internal server error"});}
}
