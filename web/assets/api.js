// Calls to the Ollic backend, always with the signed-in user's token.
import { accessToken } from "./session.js";

const base = () => (window.OLLIC_CONFIG?.apiUrl || "").replace(/\/$/, "") + "/api";

export class ApiError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : detail?.reason || "Request failed.");
    this.status = status;
    this.code = detail?.code;
  }
}

async function request(method, path, body, retry = true, extra = {}) {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in to continue.");
  let res;
  try {
    res = await fetch(base() + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, "Could not reach the Ollic server. Check your connection and try again.");
  }
  if (res.status === 401 && retry && (await accessToken(true))) return request(method, path, body, false, extra);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.detail || "Request failed.");
  return data;
}

export const api = {
  listProjects: () => request("GET", "/projects"),
  createProject: name => request("POST", "/projects", { name }),
  getProject: id => request("GET", `/projects/${id}`),
  deleteProject: id => request("DELETE", `/projects/${id}`),
  // Phase 2: concept renders. The key makes a double-click or a retry start one render, not two.
  startRender: (projectId, body, key) => request("POST", `/projects/${projectId}/architectural-render`, body, true, { "Idempotency-Key": key }),
  editRender: (renderId, instruction, key, extra = {}) => request("POST", `/renders/${renderId}/edit`, { instruction, ...extra }, true, { "Idempotency-Key": key }),
  outputs: projectId => request("GET", `/projects/${projectId}/outputs`),
  cancelJob: id => request("POST", `/jobs/${id}/cancel`),
  writePrompt: (projectId, body) => request("POST", `/projects/${projectId}/render-prompt`, body),
  readPlan: (projectId, fileId) => request("POST", `/projects/${projectId}/plan/read`, { source_file_id: fileId }),
  fileLink: (projectId, fileId) => request("GET", `/projects/${projectId}/files/${fileId}/link`),
  videos: projectId => request("GET", `/projects/${projectId}/videos`),
  deleteFile: (projectId, fileId) => request("DELETE", `/projects/${projectId}/files/${fileId}`),
  deleteRender: renderId => request("DELETE", `/renders/${renderId}`),
  deleteVideo: videoId => request("DELETE", `/videos/${videoId}`),
  makeClip: (projectId, body) => request("POST", `/projects/${projectId}/cinematic`, body),
};

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Uploads one file with progress. Resolves with the stored file record. */
export async function uploadFile(projectId, file, onProgress) {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in to continue.");
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base()}/projects/${projectId}/uploads`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, "The upload was interrupted. Check your connection and try again."));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.detail || "The upload failed."));
    };
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

/** Sends a finished animation video with its settings. Resolves with the export job. */
export async function uploadAnimation(projectId, blob, meta, onProgress) {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in to continue.");
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base()}/projects/${projectId}/animations`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, "The upload was interrupted. Check your connection and export again."));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.detail || "The upload failed."));
    };
    const form = new FormData();
    form.append("file", blob, "construction.mp4");
    form.append("meta", JSON.stringify(meta));
    xhr.send(form);
  });
}
