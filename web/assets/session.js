// Sign-in through Supabase Auth's REST API. Keeps the session in this browser and
// refreshes the access token before it expires.
const KEY = "ollic.session";
const cfg = () => window.OLLIC_CONFIG || {};

export class AuthError extends Error {}

function store(session) {
  try { session ? localStorage.setItem(KEY, JSON.stringify(session)) : localStorage.removeItem(KEY); } catch { /* private mode: session lasts for this page only */ }
  memory = session;
}
let memory = null;
function load() {
  if (memory) return memory;
  try { memory = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { memory = null; }
  return memory;
}

async function auth(path, { method = "POST", body, token } = {}) {
  const res = await fetch(`${cfg().supabaseUrl}/auth/v1/${path}`, {
    method,
    headers: { apikey: cfg().supabaseAnonKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(friendly(data, res.status));
  return data;
}

function friendly(data, status) {
  const msg = data.msg || data.error_description || data.message || "";
  if (/invalid login credentials/i.test(msg)) return "That email and password do not match an account.";
  if (/email not confirmed/i.test(msg)) return "Confirm your email first: open the link we sent you.";
  if (/already registered|already exists/i.test(msg)) return "An account with this email already exists. Sign in instead.";
  if (/password/i.test(msg) && /characters|weak|short/i.test(msg)) return msg;
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  return msg || "Something went wrong. Try again.";
}

function toSession(data) {
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600), user: data.user };
}

export function currentUser() { return load()?.user || null; }

export async function signIn(email, password) {
  const data = await auth("token?grant_type=password", { body: { email, password } });
  store(toSession(data));
  return data.user;
}

/** Returns true when the account still needs its email confirmed. */
export async function signUp(email, password, fullName) {
  const data = await auth("signup", { body: { email, password, data: { full_name: fullName } } });
  if (data.access_token) { store(toSession(data)); return false; }
  return true;
}

export async function requestPasswordReset(email) {
  const redirect = new URL("app.html", location.href).href;
  await auth(`recover?redirect_to=${encodeURIComponent(redirect)}`, { body: { email } });
}

export async function setNewPassword(password) {
  const s = load();
  if (!s) throw new AuthError("The reset link has expired. Ask for a new one.");
  const user = await auth("user", { method: "PUT", body: { password }, token: s.access_token });
  store({ ...s, user });
}

export async function signOut() {
  const s = load();
  store(null);
  if (s) await auth("logout", { token: s.access_token }).catch(() => {});
}

/** A valid access token, refreshed first if it is about to expire. */
export async function accessToken(force = false) {
  const s = load();
  if (!s) return null;
  if (!force && s.expires_at - 60 > Date.now() / 1000) return s.access_token;
  try {
    const data = await auth("token?grant_type=refresh_token", { body: { refresh_token: s.refresh_token } });
    store(toSession(data));
    return data.access_token;
  } catch {
    store(null);
    return null;
  }
}

/** Handles links from Supabase emails (#access_token=...&type=recovery|signup). */
export function takeSessionFromUrl() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("error_description")) { history.replaceState(null, "", location.pathname); return { error: h.get("error_description") }; }
  if (!h.get("access_token")) return null;
  const type = h.get("type");
  store({ access_token: h.get("access_token"), refresh_token: h.get("refresh_token"), expires_at: Number(h.get("expires_at")) || Math.floor(Date.now() / 1000) + Number(h.get("expires_in") || 3600), user: null });
  history.replaceState(null, "", location.pathname);
  return { type };
}

export async function loadUser() {
  const s = load();
  if (!s) return null;
  if (s.user) return s.user;
  const token = await accessToken();
  if (!token) return null;
  const user = await auth("user", { method: "GET", token });
  store({ ...load(), user });
  return user;
}
