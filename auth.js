(function () {
  document.documentElement.classList.add("auth-unverified");
  const privateHashes = new Set(["#dashboard", "#profile"]);
  let currentSession = null;
  let authReady = false;

  function isAuthPage() {
    return (
      location.pathname === "/login" ||
      location.pathname.endsWith("/login.html") ||
      location.pathname === "/signup" ||
      location.pathname.endsWith("/signup.html")
    );
  }

  function authUrl(path) {
    if (location.protocol === "file:")
      return path.endsWith(".html") ? path : `${path}.html`;
    return path;
  }

  function nextUrl() {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  async function getSession() {
    if (location.protocol === "file:")
      return { authenticated: false, user: null };

    try {
      const response = await fetch("/api/session", {
        credentials: "include",
      });
      if (!response.ok) return { authenticated: false, user: null };
      return response.json();
    } catch {
      return { authenticated: false, user: null };
    }
  }

  function loginRedirect() {
    location.href = `${authUrl("/login")}?next=${encodeURIComponent(
      nextUrl(),
    )}`;
  }

  function guardPrivateHash() {
    if (!authReady) return;

    if (privateHashes.has(location.hash) && !currentSession?.authenticated) {
      loginRedirect();
    }
  }

  function updateProfileNames(user) {
    if (!user) {
      [
        "profileName",
        "profileSectionName",
        "dashboardProfileName",
        "profileNameInput",
      ].forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;

        if (element.tagName === "INPUT") element.value = "";
        else element.textContent = "Learner";
      });

      document
        .querySelectorAll("[data-auth-user-name]")
        .forEach((el) => (el.textContent = "Learner"));

      document
        .querySelectorAll("[data-auth-user-email]")
        .forEach((el) => (el.textContent = ""));
      return;
    }

    [
      "profileName",
      "profileSectionName",
      "dashboardProfileName",
      "profileNameInput",
    ].forEach((id) => {
      const element = document.getElementById(id);
      if (!element) return;

      if (element.tagName === "INPUT") element.value = user.name;
      else {
        element.textContent = user.name;
      }
    });

    document
      .querySelectorAll("[data-auth-user-name]")
      .forEach((el) => (el.textContent = user.name));

    document
      .querySelectorAll("[data-auth-user-email]")
      .forEach((el) => (el.textContent = user.email));

    const supportName = document.querySelector(
      ".support-form input[placeholder='Name']",
    );
    const supportEmail = document.querySelector(
      ".support-form input[placeholder='Email']",
    );

    if (supportName && !supportName.value) supportName.value = user.name;
    if (supportEmail && !supportEmail.value) supportEmail.value = user.email;
  }

  function renderAuthNav() {
    function inject() {
      document.querySelectorAll(".nav-links").forEach((navLinks) => {
        let slot = navLinks.querySelector(".auth-nav-item");

        if (!slot) {
          slot = document.createElement("li");
          slot.className = "auth-nav-item";
          navLinks.appendChild(slot);
        }

        if (currentSession?.authenticated) {
          slot.innerHTML = "";

          const chip = document.createElement("span");
          chip.className = "nav-user-chip";
          chip.title = currentSession.user.email;
          chip.innerHTML = `<i class="fas fa-user-circle"></i><span></span>`;
          chip.querySelector("span").textContent = currentSession.user.name;

          const btn = document.createElement("button");
          btn.className = "nav-auth-link";
          btn.type = "button";
          btn.setAttribute("data-auth-logout", "");
          btn.innerHTML = `<i class="fas fa-right-from-bracket"></i> Logout`;

          slot.append(chip, btn);
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

    if (document.querySelector(".nav-links")) {
      inject();
    } else {
      const observer = new MutationObserver(() => {
        if (document.querySelector(".nav-links")) {
          observer.disconnect();
          inject();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function wireLogout() {
    document.addEventListener("click", async (event) => {
      const logoutButton = event.target.closest("[data-auth-logout]");
      if (!logoutButton) return;

      event.preventDefault();
      logoutButton.disabled = true;

      if (location.protocol !== "file:") {
        try {
          const response = await fetch("/api/logout", {
            method: "POST",
            credentials: "include",
          });

          if (!response.ok) throw new Error("Logout failed.");
        } catch (error) {
          console.warn("Logout failed", error);
          logoutButton.disabled = false;
          return;
        }
      }

      location.href = authUrl("/login");
    }); // ✅ closes addEventListener
  } // ✅ closes wireLogout

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

    if (next && next.startsWith("/") && !next.startsWith("//")) {
      return next;
    }
    return "/";
  }

  function wireAuthForm() {
    const form = document.querySelector("[data-auth-form]");
    if (!form) return;

    const mode = form.dataset.authForm;
    const passwordInput = form.querySelector("input[name='password']");
    const strengthBar = form.querySelector("[data-password-strength]");

    const validators = {
      name: (val) =>
        val.trim().length >= 2 ? "" : "Name must be at least 2 characters.",
      email: (val) =>
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(val.trim())
          ? ""
          : "Please enter a valid email address.",
      password: (val) => {
        if (mode === "login")
          return val.length > 0 ? "" : "Password is required.";
        if (val.length < 8) return "Password must be at least 8 characters.";
        if (!/[A-Z]/.test(val)) return "Must include an uppercase letter.";
        if (!/[a-z]/.test(val)) return "Must include a lowercase letter.";
        if (!/\d/.test(val)) return "Must include a number.";
        if (!/[^A-Za-z0-9]/.test(val))
          return "Must include a special character.";
        return "";
      },
      confirmPassword: (val) => {
        if (mode === "login") return "";
        return val === passwordInput?.value ? "" : "Passwords do not match.";
      },
    };

    function showError(input, message) {
      let errorEl = input.parentElement.querySelector(".inline-error");

      if (!errorEl) {
        errorEl = document.createElement("div");
        errorEl.className = "inline-error";
        errorEl.style.color = "#ef4444";
        errorEl.style.fontSize = "0.8rem";
        errorEl.style.marginTop = "0.3rem";
        input.parentElement.appendChild(errorEl);
      }

      errorEl.textContent = message;
      input.style.borderColor = message
        ? "#ef4444"
        : "rgba(255, 255, 255, 0.1)";
    }

    form.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", () => {
        if (validators[input.name]) {
          showError(input, validators[input.name](input.value));
        }

        if (input.name === "password" && strengthBar) {
          strengthBar.dataset.score = String(passwordStrength(input.value));

          const confirmInput = form.querySelector(
            "input[name='confirmPassword']",
          );

          if (confirmInput && confirmInput.value) {
            showError(
              confirmInput,
              validators.confirmPassword(confirmInput.value),
            );
          }
        }
      });

      input.addEventListener("blur", () => {
        if (validators[input.name]) {
          showError(input, validators[input.name](input.value));
        }
      });
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      let isValid = true;
      const formData = new FormData(form);
      const dataObj = Object.fromEntries(formData.entries());

      form.querySelectorAll("input").forEach((input) => {
        if (validators[input.name]) {
          const errorMsg = validators[input.name](input.value);
          showError(input, errorMsg);
          if (errorMsg) isValid = false;
        }
      });

      if (!isValid) {
        setFormMessage(
          form,
          "Please fix the errors above before submitting.",
          "error",
        );
        return;
      }
      
      // Loading state ON
const submitButton = form.querySelector("button[type='submit']");
if (!submitButton) return; // Guard add karo
submitButton.disabled = true;
submitButton.dataset.loading = "true";
submitButton.innerHTML = `
  <span class="btn-spinner"></span>
  <span>${mode === "login" ? "Logging in..." : "Signing up..."}</span>
`;
setFormMessage(form, "Working...", "info");

      try {
        const response = await fetch(`/api/${mode}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dataObj),
        });

        const payload = await response.json();
        if (!response.ok)
          throw new Error(payload.error || "Authentication failed.");

        setFormMessage(form, "Success. Redirecting...", "success");
        location.href = getNextDestination();
      } catch (error) {
        setFormMessage(form, error.message, "error");
      } finally {
    submitButton.disabled = false;
    delete submitButton.dataset.loading;
    // Restore button text
    submitButton.innerHTML = mode === "login"
        ? `<i class="fas fa-right-to-bracket"></i><span>Log In</span>`
        : `<i class="fas fa-user-plus"></i><span>Sign Up</span>`;
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

    box.textContent =
      "Authentication requires running the server. Open this app at http://127.0.0.1:3000 (run: npm start or node server.js).";

    container.prepend(box);

    if (form) {
      const submitBtn = form.querySelector("button[type='submit']");
      if (submitBtn) submitBtn.disabled = true;
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (location.protocol === "file:") {
      renderFileModeError();
      currentSession = {
        authenticated: false,
        user: null,
      };
      document.documentElement.classList.remove("auth-verified");
      document.documentElement.classList.add("auth-unverified");
      authReady = true;
      window.algoAuth = currentSession;

      renderAuthNav();
      wireLogout();
      wireAuthForm();
      wireDeactivateAccount();
      wireChangePassword();
      wireDeleteAccount();
      updateProfileNames(currentSession.user);
      guardPrivateHash();

      window.addEventListener("hashchange", guardPrivateHash);
      return;
    }

    currentSession = await getSession();
    authReady = true;
    window.algoAuth = currentSession;

    if (currentSession.authenticated) {
      document.documentElement.classList.remove("auth-unverified");
      document.documentElement.classList.add("auth-verified");
    } else {
      document.documentElement.classList.remove("auth-verified");
      document.documentElement.classList.add("auth-unverified");
    }

    if (currentSession.authenticated && isAuthPage()) {
      location.href = getNextDestination();
      return;
    }

    renderAuthNav();
    wireLogout();
    wireAuthForm();
    wireDeactivateAccount();
    wireChangePassword();
    wireDeleteAccount();
    updateProfileNames(currentSession.user);

    window.addEventListener("hashchange", guardPrivateHash);
    guardPrivateHash();
  });
})();

function wireDeactivateAccount() {
  const btn = document.getElementById(
    "deactivateAccountBtn"
  );

  if (!btn) return;

  btn.addEventListener("click", async () => {
    const confirmed = confirm(
      "Are you sure you want to deactivate your account?"
    );

    if (!confirmed) return;

    try {
      const response = await fetch(
        "/api/deactivate-account",
        {
          method: "POST",
          credentials: "include",
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Failed to deactivate account."
        );
      }

      alert("Account deactivated successfully.");

      window.location.href = "/login";
    } catch (error) {
      alert(error.message);
    }
  });
}

function wireDeleteAccount() {
  const btn = document.getElementById(
    "deleteAccountBtn"
  );

  if (!btn) return;

  btn.addEventListener("click", async () => {
    const confirmed = confirm(
      "This action is permanent. Delete account?"
    );

    if (!confirmed) return;

    const password = prompt(
      "Enter your password to continue:"
    );

    if (!password) return;

    try {
      const response = await fetch(
        "/api/delete-account",
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            password,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            "Failed to delete account."
        );
      }

      alert(
        "Account deleted successfully."
      );

      window.location.href = "/login";
    } catch (error) {
      alert(error.message);
    }
  });
}

function wireChangePassword() {
  const modal =
    document.getElementById(
      "changePasswordModal"
    );

  const openBtn =
    document.getElementById(
      "changePasswordBtn"
    );

  if (!modal || !openBtn) return;

  const closeBtn =
    document.getElementById(
      "changePasswordClose"
    );

  const cancelBtn =
    document.getElementById(
      "cancelPasswordChange"
    );

  const saveBtn =
    document.getElementById(
      "savePasswordBtn"
    );

  const message =
    document.getElementById(
      "changePasswordMessage"
    );

  function closeModal() {
    modal.classList.remove("active");
  }

  openBtn.addEventListener("click", () => {
    modal.classList.add("active");
  });

  closeBtn?.addEventListener(
    "click",
    closeModal
  );

  cancelBtn?.addEventListener(
    "click",
    closeModal
  );

  saveBtn?.addEventListener(
    "click",
    async () => {
      const currentPassword =
        document.getElementById(
          "currentPassword"
        ).value;

      const newPassword =
        document.getElementById(
          "newPassword"
        ).value;

      const confirmPassword =
        document.getElementById(
          "confirmNewPassword"
        ).value;

      message.textContent = "";

      try {
        const response = await fetch(
          "/api/change-password",
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              currentPassword,
              newPassword,
              confirmPassword,
            }),
          }
        );

        const data =
          await response.json();

        if (!response.ok) {
          throw new Error(
            data.error
          );
        }

        alert(
          "Password changed successfully. Please login again."
        );

        window.location.href =
          "/login";
      } catch (error) {
        message.textContent =
          error.message;
      }
    }
  );
}