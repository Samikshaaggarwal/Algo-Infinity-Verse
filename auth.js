(function () {
  const privateHashes = new Set(["#dashboard", "#profile"]);
  let currentSession = null;

  function isAuthPage() {
    return location.pathname === "/login" ||
      location.pathname.endsWith("/login.html") ||
      location.pathname === "/signup" ||
      location.pathname.endsWith("/signup.html");
  }

  function authUrl(path) {
    if (location.protocol === "file:") return path.endsWith(".html") ? path : `${path}.html`;
    return path;
  }

  function nextUrl() {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  async function getSession() {
    if (location.protocol === "file:") return { authenticated: false, user: null };
    try {
      const response = await fetch("/api/session", { credentials: "include" });
      if (!response.ok) return { authenticated: false, user: null };
      return response.json();
    } catch {
      return { authenticated: false, user: null };
    }
  }

  function loginRedirect() {
    location.href = `${authUrl("/login")}?next=${encodeURIComponent(nextUrl())}`;
  }

  function guardPrivateHash() {
    if (privateHashes.has(location.hash) && !currentSession?.authenticated) {
      loginRedirect();
    }
  }

  function updateProfileNames(user) {
    if (!user) return;
    [
      "profileName",
      "profileSectionName",
      "dashboardProfileName",
      "profileNameInput",
    ].forEach((id) => {
      const element = document.getElementById(id);
      if (!element) return;
      if (element.tagName === "INPUT") element.value = user.name;
      else if (!element.textContent || element.textContent.trim() === "Learner") {
        element.textContent = user.name;
      }
    });

    document.querySelectorAll("[data-auth-user-name]").forEach((element) => {
      element.textContent = user.name;
    });
    document.querySelectorAll("[data-auth-user-email]").forEach((element) => {
      element.textContent = user.email;
    });

    const supportName = document.querySelector(".support-form input[placeholder='Name']");
    const supportEmail = document.querySelector(".support-form input[placeholder='Email']");
    if (supportName && !supportName.value) supportName.value = user.name;
    if (supportEmail && !supportEmail.value) supportEmail.value = user.email;
  }

  function renderAuthNav() {
    document.querySelectorAll(".nav-links").forEach((navLinks) => {
      let slot = navLinks.querySelector(".auth-nav-item");
      if (!slot) {
        slot = document.createElement("li");
        slot.className = "auth-nav-item";
        navLinks.appendChild(slot);
      }

      if (currentSession?.authenticated) {
        slot.innerHTML = `
          <span class="nav-user-chip" title="${currentSession.user.email}">
            <i class="fas fa-user-circle"></i>
            <span>${currentSession.user.name}</span>
          </span>
          <button class="nav-auth-link" type="button" data-auth-logout>
            <i class="fas fa-right-from-bracket"></i>
            Logout
          </button>
        `;
      } else {
        slot.innerHTML = `
          <a class="nav-auth-link" href="${authUrl("/login")}">
            <i class="fas fa-right-to-bracket"></i>
            Login
          </a>
          <a class="nav-auth-link nav-auth-primary" href="${authUrl("/signup")}">
            Sign Up
          </a>
        `;
      }
    });
  }

  function wireLogout() {
    document.addEventListener("click", async (event) => {
      const logoutButton = event.target.closest("[data-auth-logout]");
      if (!logoutButton) return;
      event.preventDefault();
      logoutButton.disabled = true;

      if (location.protocol !== "file:") {
        await fetch("/api/logout", { method: "POST", credentials: "include" });
      }
      localStorage.removeItem("algoInfinityVerse");
      location.href = authUrl("/login");
    });
  }

  function passwordStrength(password) {
    let score = 0;
    if (password.length >= 8) score += 1;
    if (/[a-z]/.test(password)) score += 1;
    if (/[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^A-Za-z0-9]/.test(password)) score += 1;
    return score;
  }

  function setFormMessage(form, message, type) {
    const messageBox = form.querySelector("[data-auth-message]");
    if (!messageBox) return;
    messageBox.textContent = message;
    messageBox.className = `auth-message ${type || ""}`.trim();
  }

  function getNextDestination() {
    const params = new URLSearchParams(location.search);
    const next = params.get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) return next;
    return "/";
  }

  function wireAuthForm() {
    const form = document.querySelector("[data-auth-form]");
    if (!form) return;

    const passwordInput = form.querySelector("input[name='password']");
    const strengthBar = form.querySelector("[data-password-strength]");
    if (passwordInput && strengthBar) {
      passwordInput.addEventListener("input", () => {
        strengthBar.dataset.score = String(passwordStrength(passwordInput.value));
      });
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector("button[type='submit']");
      const mode = form.dataset.authForm;
      const formData = Object.fromEntries(new FormData(form).entries());

      if (mode === "signup" && formData.password !== formData.confirmPassword) {
        setFormMessage(form, "Passwords do not match.", "error");
        return;
      }

      submitButton.disabled = true;
      submitButton.dataset.loading = "true";
      setFormMessage(form, "Working...", "info");

      try {
        const response = await fetch(`/api/${mode}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Authentication failed.");
        setFormMessage(form, "Success. Redirecting...", "success");
        location.href = getNextDestination();
      } catch (error) {
        setFormMessage(form, error.message, "error");
      } finally {
        submitButton.disabled = false;
        delete submitButton.dataset.loading;
      }
    });
  }

  function renderFileModeError() {
    const form = document.querySelector("[data-auth-form]");
    const container = form?.closest("main") || document.body;

    const box = document.createElement("div");
    box.style.margin = "16px 0";
    box.style.padding = "12px 14px";
    box.style.border = "1px solid #ef4444";
    box.style.borderRadius = "10px";
    box.style.background = "rgba(239,68,68,0.08)";
    box.style.color = "#ef4444";
    box.style.fontWeight = "600";
    box.setAttribute("role", "alert");

    const serverHint = `${location.origin || "http://127.0.0.1:3000"}`;

    box.textContent =
      "Authentication requires running the server. Open this app at http://127.0.0.1:3000 (run: npm start or node server.js).";

    container.prepend(box);

    // Disable form submission in file mode to avoid confusing errors.
    if (form) {
      const submitBtn = form.querySelector("button[type='submit']");
      if (submitBtn) submitBtn.disabled = true;
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    // Explicitly handle file:// (auth.js can't set/verify cookie sessions there)
    if (location.protocol === "file:") {
      renderFileModeError();
      currentSession = { authenticated: false, user: null };
      window.algoAuth = currentSession;
      renderAuthNav();
      wireLogout();
      wireAuthForm();
      updateProfileNames(currentSession.user);
      guardPrivateHash();
      window.addEventListener("hashchange", guardPrivateHash);
      return;
    }

    currentSession = await getSession();
    window.algoAuth = currentSession;

    if (currentSession.authenticated && isAuthPage()) {
      location.href = getNextDestination();
      return;
    }

    renderAuthNav();
    wireLogout();
    wireAuthForm();
    updateProfileNames(currentSession.user);
    guardPrivateHash();
    window.addEventListener("hashchange", guardPrivateHash);
  });
})();

