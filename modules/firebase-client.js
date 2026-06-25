import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithRedirect, signOut, onAuthStateChanged, sendPasswordResetEmail } from "firebase/auth";

let configPromise = null;
let app = null;
let auth = null;
let stateListeners = [];

function fetchConfig() {
  if (!configPromise) {
    configPromise = fetch("/api/firebase-config")
      .then(r => r.json())
      .then(data => {
        if (!data.configured) throw new Error("Firebase not configured");
        return data;
      })
      .catch(() => {
        configPromise = null;
        throw new Error("Firebase not configured");
      });
  }
  return configPromise;
}

async function ensureAuth() {
  if (auth) return auth;
  const config = await fetchConfig();
  if (!app) {
    app = initializeApp({
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      storageBucket: config.storageBucket,
      messagingSenderId: config.messagingSenderId,
      appId: config.appId,
    });
  }
  if (!auth) {
    auth = getAuth(app);
    auth.onAuthStateChanged((user) => {
      stateListeners.forEach(cb => { try { cb(user); } catch (e) { console.warn("Firebase auth listener error:", e); } });
    });
  }
  return auth;
}

export async function getRedirectUser() {
  const authInstance = await ensureAuth();

  await new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
      if (user) {
        unsubscribe();
        resolve(user);
      }
    });

    setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, 5000);
  });

  const user = authInstance.currentUser;
  if (!user) return null;

  try {
    const idToken = await user.getIdToken(true);
    return { idToken, user };
  } catch (tokenError) {
    console.warn("getIdToken after redirect failed:", tokenError);
    return null;
  }
}

export async function signInWithGoogle() {
  const authInstance = await ensureAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithRedirect(authInstance, provider);
}

export async function signOutUser() {
  if (!auth) return;
  await signOut(auth);
}

export function getCurrentUser() {
  return auth ? auth.currentUser : null;
}

export function onAuthChange(callback) {
  stateListeners.push(callback);
  if (auth && auth.currentUser !== undefined) {
    try { callback(auth.currentUser); } catch (e) { console.warn(e); }
  }
  return () => {
    stateListeners = stateListeners.filter(cb => cb !== callback);
  };
}

export async function getIdToken() {
  const currentUser = getCurrentUser();
  if (!currentUser) return null;
  return currentUser.getIdToken();
}

export async function sendPasswordReset(email) {
  const authInstance = await ensureAuth();
  await sendPasswordResetEmail(authInstance, email);
}

export function isConfigured() {
  return auth !== null;
}

window.__firebaseClient = {
  signInWithGoogle,
  getRedirectUser,
  signOutUser,
  getCurrentUser,
  onAuthChange,
  getIdToken,
  sendPasswordReset,
  isConfigured
};