// Fallback only. When the backend serves the website (local dev and Railway), it
// replaces this file with the values from its environment. Fill these in only if the
// website is hosted somewhere else.
// Public settings for the website. These values are safe to publish: the anon key
// only allows what row-level security permits. Never put the service-role key here.
window.OLLIC_CONFIG = {
  supabaseUrl: "",       // e.g. "https://abcdefghijkl.supabase.co"
  supabaseAnonKey: "",   // Project Settings > API > anon / publishable key
  apiUrl: "",            // the FastAPI backend, e.g. "http://localhost:8000"; empty = same site
};
