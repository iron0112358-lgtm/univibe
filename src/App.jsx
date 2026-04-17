import { useState, useEffect, useCallback, Component } from "react";

// ─── Supabase REST Client (no external library needed) ────────────────────────
const SB_URL = "https://hdnbrarxisehdmqtswqq.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkbmJyYXJ4aXNlaGRtcXRzd3FxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5OTc5NzQsImV4cCI6MjA4ODU3Mzk3NH0.p7wkBnmPibh8PFDgyfnh49KyYSzY6UVfUFHDwW0pb6c";

// All Supabase calls go through this one fetch wrapper
async function sb(path, options = {}) {
  const { method = "GET", body, token, params } = options;
  let url = `${SB_URL}/rest/v1/${path}`;
  if (params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    url += "?" + qs;
  }
  const headers = {
    "apikey": SB_KEY,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  else        headers["Authorization"] = `Bearer ${SB_KEY}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) return { error: data?.message || data?.error || `Error ${res.status}`, data: null };
  return { data, error: null };
}

// Auth calls go to a different endpoint
async function sbAuth(path, body) {
  const res = await fetch(`${SB_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { "apikey": SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) return { error: data?.error_description || data?.msg || data?.message || "Auth error", data: null };
  return { data, error: null };
}

// ─── Session Persistence ─────────────────────────────────────────────────────
const SESSION_KEY = "univibe_session";

function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.id || !s?.refresh_token) return null;
    return s;
  } catch { return null; }
}

let _session = loadSession();

// ─── Constants ────────────────────────────────────────────────────────────────
const ADMIN_EMAIL = "chichinadze.sab@gmail.com";
const VALID_CATS = ["Tech", "Sports", "Social", "Education", "Entrepreneurship"];
const ALL_CATS   = ["All", ...VALID_CATS];
const CAT_ICON   = { Tech:"⚡", Sports:"🏃", Social:"🎉", Education:"📚", Entrepreneurship:"🚀" };
const PAGE_SIZE  = 9;

function todayMin() {
  const d  = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}T00:00`;
}
const DATE_MAX = "2030-12-31T23:59";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtDate = s => { try { return new Date(s).toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric", year:"numeric" }); } catch { return ""; } };
const fmtTime = s => { try { return new Date(s).toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" }); } catch { return ""; } };
const capPct  = (n, m) => Math.min(100, m > 0 ? Math.round((n / m) * 100) : 0);
const trunc   = (s, n = 120) => String(s || "").trim().slice(0, n);
const wrap    = async (fn, fallback) => { try { return await fn(); } catch (e) { console.error(e); return fallback; } };

// ─── Name Extractor ──────────────────────────────────────────────────────────
function nameFromEmail(email) {
  try {
    const local = email.split("@")[0]; // chichinadze.saba2
    const parts = local.split(".");    // ["chichinadze", "saba2"]
    return parts
      .map(p => p.replace(/[0-9]/g, ""))          // remove numbers
      .filter(p => p.length > 0)                   // remove empty parts
      .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()) // capitalize
      .join(" ");                                   // "Chichinadze Saba"
  } catch { return email.split("@")[0]; }
}

// ─── DB Layer ─────────────────────────────────────────────────────────────────
const db = {

  async signUp(email, password) {
    return wrap(async () => {
      email = String(email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email." };
      if (!email.endsWith("@kiu.edu.ge")) return { error: "Only KIU university emails (@kiu.edu.ge) are allowed." };
      if (String(password || "").length < 6) return { error: "Password must be at least 6 characters." };

      const { data: auth, error: authErr } = await sbAuth("signup", { email, password });
      if (authErr) return { error: authErr };

      // Don't save to public.users yet — only save on first successful sign in
      // This ensures only real verified emails get into the platform
      return { data: "verify" };
    }, { error: "Sign up failed. Please try again." });
  },

  async signIn(email, password) {
    return wrap(async () => {
      email = String(email || "").trim().toLowerCase();
      if (!email)    return { error: "Email is required." };
      if (!password) return { error: "Password is required." };

      const { data: auth, error } = await sbAuth("token?grant_type=password", { email, password });
      if (error) return { error };

      const token = auth.access_token;
      const userId = auth.user.id;

      // Fetch profile
      const profileRes = await fetch(`${SB_URL}/rest/v1/users?id=eq.${userId}&select=name`, {
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
      });
      const profile = await profileRes.json();
      let name = profile?.[0]?.name;

      // Auto-create profile if missing
      if (!name) {
        name = nameFromEmail(email);
        await fetch(`${SB_URL}/rest/v1/users`, {
          method: "POST",
          headers: {
            "apikey": SB_KEY,
            "Authorization": `Bearer ${SB_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({ id: userId, name, email }),
        });
      }

      _session = {
        id: userId, email, name, token,
        refresh_token: auth.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (auth.expires_in || 3600),
      };
      saveSession(_session);
      return { data: _session };
    }, { error: "Sign in failed. Please try again." });
  },

  signOut() { _session = null; clearSession(); },
  getSession() { return _session; },

  async refreshSession() {
    return wrap(async () => {
      const saved = loadSession();
      if (!saved?.refresh_token) return null;
      const now = Math.floor(Date.now() / 1000);
      if (saved.expires_at && saved.expires_at > now + 60) {
        _session = saved;
        return _session;
      }
      const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "apikey": SB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: saved.refresh_token }),
      });
      if (!res.ok) { clearSession(); return null; }
      const auth = await res.json();
      if (!auth?.access_token) { clearSession(); return null; }
      _session = {
        id: saved.id, email: saved.email, name: saved.name,
        token: auth.access_token,
        refresh_token: auth.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (auth.expires_in || 3600),
      };
      saveSession(_session);
      return _session;
    }, null);
  },

  async getTrending() {
    return wrap(async () => {
      // Get top 3 events by attendee count
      const evRes = await fetch(
        `${SB_URL}/rest/v1/events?select=id,title,description,date,location,category,host_id,max_participants,created_at,is_private&order=created_at.desc&limit=50`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
      );
      const events = await evRes.json();
      if (!Array.isArray(events) || events.length === 0) return [];

      // Get attendee counts for all
      const ids = events.map(e => e.id).join(",");
      const attRes = await fetch(
        `${SB_URL}/rest/v1/event_attendees?select=event_id&status=eq.approved&event_id=in.(${ids})`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
      );
      const att = await attRes.json();
      const countMap = {};
      (att || []).forEach(r => { countMap[r.event_id] = (countMap[r.event_id] || 0) + 1; });

      // Sort by count, take top 3
      const sorted = events
        .map(e => ({ ...e, attendee_count: countMap[e.id] || 0 }))
        .sort((a, b) => b.attendee_count - a.attendee_count)
        .slice(0, 3);

      // Fetch host names
      const hostIds = [...new Set(sorted.map(e => e.host_id).filter(Boolean))];
      let nameMap = {};
      if (hostIds.length) {
        const nRes = await fetch(`${SB_URL}/rest/v1/users?id=in.(${hostIds.join(",")})&select=id,name`,
          { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } });
        const names = await nRes.json();
        (names || []).forEach(u => { nameMap[u.id] = u.name; });
      }

      return sorted.map(e => ({ ...e, host_name: nameMap[e.host_id] || "Unknown" }));
    }, []);
  },

  async getEvents(category, page = 0, search = "") {
    return wrap(async () => {
      const from = page * PAGE_SIZE;

      // Fetch events without join
      let url = `${SB_URL}/rest/v1/events?select=id,title,description,date,location,category,host_id,max_participants,created_at,is_private&order=created_at.desc`;
      if (category && category !== "All") url += `&category=eq.${encodeURIComponent(category)}`;
      if (search?.trim()) url += `&title=ilike.${encodeURIComponent("*" + search.trim() + "*")}`;
      url += `&offset=${from}&limit=${PAGE_SIZE}`;

      const res = await fetch(url, {
        headers: {
          "apikey": SB_KEY,
          "Authorization": `Bearer ${SB_KEY}`,
          "Prefer": "count=exact",
        },
      });
      const total = parseInt(res.headers.get("content-range")?.split("/")[1] || "0");
      const data  = await res.json();

      if (!res.ok || !Array.isArray(data)) return { data: [], total: 0 };

      // Fetch host names separately
      const hostIds = [...new Set((data || []).map(e => e.host_id).filter(Boolean))];
      let nameMap = {};
      if (hostIds.length > 0) {
        const nRes = await fetch(
          `${SB_URL}/rest/v1/users?id=in.(${hostIds.join(",")})&select=id,name`,
          { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
        );
        const names = await nRes.json();
        (names || []).forEach(u => { nameMap[u.id] = u.name; });
      }

      // Get attendee counts for this batch
      const ids = (data || []).map(e => `"${e.id}"`).join(",");
      let countMap = {};
      if (ids.length) {
        const attRes = await fetch(
          `${SB_URL}/rest/v1/event_attendees?select=event_id&status=eq.approved&event_id=in.(${ids})`,
          { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${_session?.token || SB_KEY}` } }
        );
        const att = await attRes.json();
        (att || []).forEach(r => { countMap[r.event_id] = (countMap[r.event_id] || 0) + 1; });
      }

      const events = (data || []).map(e => ({
        ...e,
        host_name: nameMap[e.host_id] || "Unknown",
        attendee_count: countMap[e.id] || 0,
      }));
      return { data: events, total };
    }, { data: [], total: 0 });
  },

  async getEvent(id) {
    return wrap(async () => {
      const evRes = await fetch(`${SB_URL}/rest/v1/events?id=eq.${id}&select=id,title,description,date,location,category,host_id,max_participants,created_at,is_private`, {
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
      });
      const evData = await evRes.json();
      if (!evRes.ok || !evData?.[0]) return null;
      const event = evData[0];
      const nRes = await fetch(`${SB_URL}/rest/v1/users?id=eq.${event.host_id}&select=name`, {
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
      });
      const nData = await nRes.json();
      event.host_name = nData?.[0]?.name || "Unknown";

      // Get attendee count — approved only
      const countRes = await fetch(
        `${SB_URL}/rest/v1/event_attendees?event_id=eq.${id}&status=eq.approved&select=id`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Prefer": "count=exact" } }
      );
      const count = parseInt(countRes.headers.get("content-range")?.split("/")[1] || "0");

      return { ...event, attendee_count: count };
    }, null);
  },

  async createEvent(data, userId) {
    return wrap(async () => {
      if (!_session?.token) return { error: "You must be signed in." };

      const title       = String(data.title       || "").trim().slice(0, 200);
      const description = String(data.description || "").trim().slice(0, 2000);
      const location    = String(data.location    || "").trim().slice(0, 300);
      const category    = VALID_CATS.includes(data.category) ? data.category : "Social";
      const maxP        = Math.max(1, Math.min(10000, parseInt(data.max_participants) || 50));

      if (!title)       return { error: "Title is required." };
      if (!description) return { error: "Description is required." };
      if (!location)    return { error: "Location is required." };
      if (!data.date)   return { error: "Date is required." };

      const d = new Date(data.date);
      if (isNaN(d.getTime()))         return { error: "Invalid date." };
      if (d < new Date())             return { error: "Date cannot be in the past." };
      if (d > new Date("2030-12-31")) return { error: "Date cannot exceed 2030." };

      const { data: event, error } = await sb("events", {
        method: "POST",
        token: _session.token,
        body: { title, description, location, category, date: d.toISOString(), max_participants: maxP, host_id: userId, is_private: data.is_private || false },
      });
      if (error) return { error };
      return { data: Array.isArray(event) ? event[0] : event };
    }, { error: "Could not create event. Please try again." });
  },

  async updateEvent(eventId, data) {
    return wrap(async () => {
      if (!_session?.token) return { error: "Sign in required." };
      const location = String(data.location || "").trim().slice(0, 300);
      const d = new Date(data.date);
      if (!location)          return { error: "Location is required." };
      if (isNaN(d.getTime())) return { error: "Invalid date." };
      if (d < new Date())     return { error: "Date cannot be in the past." };
      const res = await fetch(`${SB_URL}/rest/v1/events?id=eq.${eventId}`, {
        method: "PATCH",
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ location, date: d.toISOString() }),
      });
      if (!res.ok) return { error: "Could not update event." };
      return { data: true };
    }, { error: "Could not update event." });
  },

  async joinEvent(eventId, userId) {
    return wrap(async () => {
      if (!_session?.token) return { error: "Sign in required." };
      const ev = await db.getEvent(eventId);
      if (ev && ev.attendee_count >= ev.max_participants) return { error: "This event is full." };
      const res = await fetch(`${SB_URL}/rest/v1/event_attendees`, {
        method: "POST",
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ event_id: eventId, user_id: userId, status: "approved" }),
      });
      if (!res.ok) {
        const err = await res.json();
        if (JSON.stringify(err).includes("duplicate") || JSON.stringify(err).includes("unique"))
          return { error: "You already joined this event." };
        return { error: "Could not join event." };
      }
      return { data: true };
    }, { error: "Could not join event." });
  },

  async leaveEvent(eventId, userId) {
    return wrap(async () => {
      if (!_session?.token) return { error: "Sign in required." };
      const res = await fetch(
        `${SB_URL}/rest/v1/event_attendees?event_id=eq.${eventId}&user_id=eq.${userId}&status=eq.approved`,
        {
          method: "DELETE",
          headers: {
            "apikey": SB_KEY,
            "Authorization": `Bearer ${_session.token}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (!res.ok) return { error: "Could not leave event." };
      return { data: true };
    }, { error: "Could not leave event." });
  },

  async requestJoin(eventId, userId) {
    return wrap(async () => {
      if (!_session?.token) return { error: "Sign in required." };
      // Check if already has any record (pending or approved)
      const checkRes = await fetch(
        `${SB_URL}/rest/v1/event_attendees?event_id=eq.${eventId}&user_id=eq.${userId}&select=status`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
      );
      const existing = await checkRes.json();
      if (existing?.[0]?.status === "approved") return { error: "already_joined" };
      if (existing?.[0]?.status === "pending") return { error: "already_requested" };
      const res = await fetch(`${SB_URL}/rest/v1/event_attendees`, {
        method: "POST",
        headers: {
          "apikey": SB_KEY,
          "Authorization": `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({ event_id: eventId, user_id: userId, status: "pending" }),
      });
      if (!res.ok) {
        const err = await res.json();
        if (JSON.stringify(err).includes("duplicate") || JSON.stringify(err).includes("unique"))
          return { error: "already_requested" };
        return { error: "Could not send request." };
      }
      return { data: true };
    }, { error: "Could not send request." });
  },

  async cancelRequest(eventId, userId) {
    return wrap(async () => {
      const res = await fetch(
        `${SB_URL}/rest/v1/event_attendees?event_id=eq.${eventId}&user_id=eq.${userId}&status=eq.pending`,
        { method: "DELETE", headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" } }
      );
      if (!res.ok) return { error: "Could not cancel request." };
      return { data: true };
    }, { error: "Could not cancel request." });
  },

  async getRequestStatus(eventId, userId) {
    return wrap(async () => {
      const res = await fetch(
        `${SB_URL}/rest/v1/event_attendees?event_id=eq.${eventId}&user_id=eq.${userId}&select=status`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
      );
      const data = await res.json();
      return data?.[0]?.status || null;
    }, null);
  },

  async getJoinRequests(eventId) {
    return wrap(async () => {
      const attRes = await fetch(
        `${SB_URL}/rest/v1/event_attendees?event_id=eq.${eventId}&status=eq.pending&select=user_id`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
      );
      const att = await attRes.json();
      if (!Array.isArray(att) || att.length === 0) return [];
      const ids = att.map(a => a.user_id).join(",");
      const usersRes = await fetch(
        `${SB_URL}/rest/v1/users?id=in.(${ids})&select=id,name,email`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
      );
      const users = await usersRes.json();
      return Array.isArray(users) ? users : [];
    }, []);
  },

  async approveRequest(eventId, userId) {
    return wrap(async () => {
      const res = await fetch(
        `${SB_URL}/rest/v1/event_attendees?event_id=eq.${eventId}&user_id=eq.${userId}&status=eq.pending`,
        {
          method: "PATCH",
          headers: {
            "apikey": SB_KEY,
            "Authorization": `Bearer ${SB_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
            "x-upsert": "false",
          },
          body: JSON.stringify({ status: "approved" }),
        }
      );
      if (!res.ok) {
        const err = await res.text();
        console.error("approve error:", err);
        return { error: "Could not approve." };
      }
      return { data: true };
    }, { error: "Could not approve." });
  },

  async rejectRequest(eventId, userId) {
    return wrap(async () => {
      const res = await fetch(
        `${SB_URL}/rest/v1/event_attendees?event_id=eq.${eventId}&user_id=eq.${userId}&status=eq.pending`,
        {
          method: "DELETE",
          headers: {
            "apikey": SB_KEY,
            "Authorization": `Bearer ${SB_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
          },
        }
      );
      if (!res.ok) {
        const err = await res.text();
        console.error("reject error:", err);
        return { error: "Could not reject." };
      }
      return { data: true };
    }, { error: "Could not reject." });
  },

  async deleteEvent(eventId) {
    return wrap(async () => {
      if (!_session?.token) return { error: "Sign in required." };
      const res = await fetch(`${SB_URL}/rest/v1/events?id=eq.${eventId}`, {
        method: "DELETE",
        headers: {
          "apikey": SB_KEY,
          "Authorization": `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) return { error: "Could not delete event." };
      return { data: true };
    }, { error: "Could not delete event." });
  },

  async getParticipants(eventId) {
    return wrap(async () => {
      const attRes = await fetch(
        `${SB_URL}/rest/v1/event_attendees?event_id=eq.${eventId}&status=eq.approved&select=user_id`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
      );
      const att = await attRes.json();
      if (!Array.isArray(att) || att.length === 0) return [];
      const ids = att.map(a => a.user_id).join(",");
      const usersRes = await fetch(
        `${SB_URL}/rest/v1/users?id=in.(${ids})&select=id,name,email`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
      );
      const users = await usersRes.json();
      return Array.isArray(users) ? users : [];
    }, []);
  },

  async isJoined(eventId, userId) {
    return wrap(async () => {
      const res = await fetch(
        `${SB_URL}/rest/v1/event_attendees?event_id=eq.${eventId}&user_id=eq.${userId}&status=eq.approved&select=id`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Prefer": "count=exact" } }
      );
      const count = parseInt(res.headers.get("content-range")?.split("/")[1] || "0");
      return count > 0;
    }, false);
  },

  async getMyEvents(userId) {
    return wrap(async () => {
      // Get joined event IDs
      const attRes = await fetch(
        `${SB_URL}/rest/v1/event_attendees?user_id=eq.${userId}&status=eq.approved&select=event_id`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
      );
      const att = await attRes.json();
      const joinedIds = (att || []).map(a => a.event_id);

      const [joinedRaw, createdRaw] = await Promise.all([
        joinedIds.length
          ? fetch(`${SB_URL}/rest/v1/events?id=in.(${joinedIds.join(",")})&select=id,title,description,date,location,category,host_id,max_participants,created_at,is_private&order=created_at.desc`,
              { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }).then(r => r.json())
          : Promise.resolve([]),
        fetch(`${SB_URL}/rest/v1/events?host_id=eq.${userId}&select=id,title,description,date,location,category,host_id,max_participants,created_at,is_private&order=created_at.desc`,
          { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }).then(r => r.json()),
      ]);

      // Fetch host names
      const allEvents = [...(Array.isArray(joinedRaw) ? joinedRaw : []), ...(Array.isArray(createdRaw) ? createdRaw : [])];
      const hostIds = [...new Set(allEvents.map(e => e.host_id).filter(Boolean))];
      let nameMap = {};
      if (hostIds.length) {
        const nRes = await fetch(`${SB_URL}/rest/v1/users?id=in.(${hostIds.join(",")})&select=id,name`,
          { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } });
        const names = await nRes.json();
        (names || []).forEach(u => { nameMap[u.id] = u.name; });
      }

      // Fetch real attendee counts
      const allIds = allEvents.map(e => `"${e.id}"`).join(",");
      let countMap = {};
      if (allIds.length) {
        const cRes = await fetch(
          `${SB_URL}/rest/v1/event_attendees?select=event_id&status=eq.approved&event_id=in.(${allIds})`,
          { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
        );
        const counts = await cRes.json();
        (counts || []).forEach(r => { countMap[r.event_id] = (countMap[r.event_id] || 0) + 1; });
      }

      const fmt = arr => (Array.isArray(arr) ? arr : []).map(e => ({
        ...e, host_name: nameMap[e.host_id] || "Unknown", attendee_count: countMap[e.id] || 0,
      }));
      return { joined: fmt(joinedRaw), created: fmt(createdRaw) };
    }, { joined: [], created: [] });
  },

  async getStats() {
    return wrap(async () => {
      const [evRes, attRes, catRes] = await Promise.all([
        fetch(`${SB_URL}/rest/v1/events?select=id`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Prefer": "count=exact" } }),
        fetch(`${SB_URL}/rest/v1/event_attendees?select=id&status=eq.approved`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Prefer": "count=exact" } }),
        fetch(`${SB_URL}/rest/v1/events?select=category`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }),
      ]);
      const totalEvents = parseInt(evRes.headers.get("content-range")?.split("/")[1] || "0");
      const totalJoins  = parseInt(attRes.headers.get("content-range")?.split("/")[1] || "0");
      const cats        = await catRes.json();
      const counts = {};
      (cats || []).forEach(e => { counts[e.category] = (counts[e.category] || 0) + 1; });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
      return { totalEvents, totalJoins, topCategory: top };
    }, { totalEvents: 0, totalJoins: 0, topCategory: "—" });
  },
};

// ─── Error Boundary ───────────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { crashed: false, msg: "" }; }
  static getDerivedStateFromError(e) { return { crashed: true, msg: e?.message || "Unknown error" }; }
  componentDidCatch(e, i) { console.error("[UniVibe]", e, i); }
  render() {
    if (this.state.crashed) return (
      <div style={{ padding:40, textAlign:"center", color:"#8892a4", fontFamily:"sans-serif" }}>
        <div style={{ fontSize:40, marginBottom:10 }}>⚠️</div>
        <h3 style={{ color:"#e8eaf0", marginBottom:8 }}>Something went wrong</h3>
        <p style={{ fontSize:14, marginBottom:18 }}>{this.state.msg}</p>
        <button onClick={() => this.setState({ crashed:false })}
          style={{ background:"#f59e0b", border:"none", color:"#fff", padding:"9px 20px", borderRadius:8, cursor:"pointer", fontWeight:600 }}>
          Try Again
        </button>
      </div>
    );
    return this.props.children;
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&family=Inter:wght@400;500;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:#0E0E12; --bg2:#16161C; --bg3:#1E1E28; --bg4:#2A2A38;
    --purple:#A855F7; --lime:#A3E635; --pink:#F472B6; --blue:#60A5FA;
    --orange:#FB923C; --cyan:#22D3EE;
    --text:#FFFFFF; --muted:#6B7280; --muted2:#9CA3AF;
    --border:rgba(255,255,255,0.06); --border2:rgba(255,255,255,0.1);
    --card:rgba(22,22,28,0.95); --r:20px; --rs:12px;
    --glow-purple:rgba(168,85,247,0.25); --glow-lime:rgba(163,230,53,0.2);
  }
  html { scroll-behavior:smooth; }
  body { background:var(--bg); color:var(--text); font-family:'Inter',sans-serif; min-height:100vh; overflow-x:hidden; }
  body::before { content:''; position:fixed; inset:0; z-index:-1;
    background:
      radial-gradient(ellipse 60% 50% at 10% 0%, rgba(168,85,247,0.12) 0%, transparent 60%),
      radial-gradient(ellipse 50% 40% at 90% 100%, rgba(163,230,53,0.07) 0%, transparent 55%),
      radial-gradient(ellipse 40% 35% at 50% 50%, rgba(96,165,250,0.04) 0%, transparent 60%),
      var(--bg); }
  ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:4px}
  .app{min-height:100vh;display:flex;flex-direction:column}
  .container{max-width:1200px;margin:0 auto;padding:0 20px;width:100%}

  /* NAV */
  .nav{position:sticky;top:0;z-index:100;background:rgba(14,14,18,0.92);backdrop-filter:blur(24px);border-bottom:1px solid var(--border)}
  .nav-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:center;height:56px;padding:0 20px;gap:4px}
  .logo{display:none}
  .logo-mark{display:none}
  .logo-text{display:none}
  .nav-links{display:flex;align-items:center;gap:4px;justify-content:center;flex:1}
  .nb{background:none;border:none;cursor:pointer;color:var(--muted2);font-family:'Inter',sans-serif;font-size:13px;font-weight:500;padding:7px 14px;border-radius:10px;transition:all 0.18s}
  .nb:hover,.nb.on{color:var(--text);background:var(--bg3)}
  .nb.cta{background:var(--lime);color:#0E0E12;font-weight:700;border-radius:100px;padding:7px 18px}
  .nb.cta:hover{opacity:.9;transform:translateY(-1px);box-shadow:0 4px 20px var(--glow-lime)}
  .nb.out{border:1px solid var(--border2);color:var(--muted2);border-radius:100px}
  .nb.out:hover{border-color:rgba(168,85,247,0.5);color:var(--purple)}
  .avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--purple),var(--pink));display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#fff;cursor:pointer;border:2px solid transparent;transition:all 0.18s;flex-shrink:0;box-shadow:0 0 12px var(--glow-purple)}
  .avatar:hover{border-color:var(--purple);transform:scale(1.05)}
  .ham{display:none;flex-direction:column;gap:5px;cursor:pointer;padding:4px}
  .ham span{display:block;width:20px;height:2px;background:var(--muted2);border-radius:2px;transition:background 0.2s}
  .ham:hover span{background:var(--text)}
  .mmenu{display:none;flex-direction:column;gap:2px;padding:10px 16px 14px;background:rgba(14,14,18,0.98);border-bottom:1px solid var(--border);backdrop-filter:blur(20px)}
  .mmenu.open{display:flex} .mmenu .nb{text-align:left;border-radius:10px}

  /* PAGE */
  .page{padding:36px 0 80px;animation:fadeUp 0.28s ease}
  @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}

  /* HERO */
  .hero{padding:60px 0 36px;text-align:center}
  .hero-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.25);padding:6px 16px;border-radius:100px;font-size:12px;color:var(--purple);font-weight:600;margin-bottom:20px;letter-spacing:0.02em}
  .hero h1{font-family:'Space Grotesk',sans-serif;font-size:clamp(32px,6vw,64px);font-weight:800;line-height:1.05;letter-spacing:-2px;margin-bottom:14px}
  .hero h1 em{font-style:normal;background:linear-gradient(135deg,var(--purple),var(--pink),var(--orange));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .hero p{font-size:16px;color:var(--muted2);max-width:420px;margin:0 auto 28px;line-height:1.65;font-weight:400}
  .hero-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}

  /* SPLIT HERO */
  .hero{padding:0;text-align:left}
  .hero-split{display:grid;grid-template-columns:1fr 1fr;min-height:320px;border-bottom:1px solid var(--border);margin-bottom:36px}
  .hero-left{display:flex;align-items:center;justify-content:center;padding:48px 32px;position:relative;overflow:hidden}
  .hero-left::before{content:'';position:absolute;inset:0;background:none;pointer-events:none}
  .hero-logo{height:480px;width:100%;max-width:100%;object-fit:contain;position:relative;z-index:1}
  .hero-right{display:flex;flex-direction:column;justify-content:center;padding:48px 40px 48px 44px}
  .hero-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.25);padding:6px 16px;border-radius:100px;font-size:12px;color:var(--purple);font-weight:600;margin-bottom:20px;width:fit-content;letter-spacing:0.02em}
  .hero h1{font-family:'Space Grotesk',sans-serif;font-size:clamp(28px,4vw,52px);font-weight:800;line-height:1.05;letter-spacing:-2px;margin-bottom:14px;text-align:left}
  .hero h1 em{font-style:normal;background:linear-gradient(135deg,var(--purple),var(--pink),var(--orange));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .hero p{font-size:15px;color:var(--muted2);margin:0 0 24px;line-height:1.65;font-weight:400;max-width:380px}
  .hero-btns{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:28px;padding:0;align-items:flex-start}

  /* STATS */
  .stats{display:flex;gap:8px;flex-wrap:nowrap;margin:0;overflow:visible}
  .scard{background:var(--bg3);border:1px solid var(--border);border-radius:14px;padding:10px 12px;text-align:center;transition:all 0.2s;position:relative;overflow:hidden;flex:1;min-width:0}
  .scard::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(168,85,247,0.03),transparent);opacity:0;transition:opacity 0.2s}
  .scard:hover{transform:translateY(-3px);border-color:rgba(168,85,247,0.2);box-shadow:0 8px 32px rgba(0,0,0,0.3)}
  .scard:hover::before{opacity:1}
  .snum{font-family:'Space Grotesk',sans-serif;font-size:24px;font-weight:800;background:linear-gradient(135deg,var(--purple),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .slbl{font-size:10px;color:var(--muted);margin-top:3px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em}

  /* FILTERS */
  .filters{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:20px}
  .pill{background:var(--bg3);border:1px solid var(--border);color:var(--muted2);padding:6px 16px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;transition:all 0.18s;letter-spacing:0.01em}
  .pill:hover{color:var(--text);border-color:var(--border2);background:var(--bg4)}
  .pill.on{background:var(--purple);color:#fff;border-color:var(--purple);box-shadow:0 0 16px var(--glow-purple)}

  /* SEARCH */
  .sbar{display:flex;align-items:center;gap:10px;background:var(--bg2);border:1.5px solid var(--border);border-radius:14px;padding:10px 16px;margin-bottom:20px;transition:all 0.18s}
  .sbar:focus-within{border-color:rgba(168,85,247,0.4);box-shadow:0 0 0 3px rgba(168,85,247,0.08)}
  .sbar input{background:none;border:none;outline:none;color:var(--text);font-family:'Inter',sans-serif;font-size:14px;flex:1}
  .sbar input::placeholder{color:var(--muted)}
  .sbar-x{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:0 2px;transition:color 0.15s}
  .sbar-x:hover{color:var(--text)}

  /* GRID */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:22px}

  /* EVENT CARD — Concert Poster Style */
  .ecard{background:var(--bg2);border:1px solid var(--border);border-radius:24px;overflow:hidden;cursor:pointer;transition:all 0.25s cubic-bezier(0.34,1.56,0.64,1);position:relative;display:flex;flex-direction:column}
  .ecard:hover{transform:translateY(-8px) scale(1.01);border-color:var(--border2);box-shadow:0 28px 60px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.05)}

  /* Banner with diagonal shimmer */
  .ecard-banner{height:130px;position:relative;display:flex;flex-direction:column;justify-content:space-between;padding:14px 14px 0;overflow:hidden}
  .ecard-banner::before{content:'';position:absolute;inset:0;background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,0.07) 50%,transparent 60%);transform:translateX(-100%);transition:transform 0.6s ease}
  .ecard:hover .ecard-banner::before{transform:translateX(200%)}
  .ecard-banner::after{content:'';position:absolute;bottom:0;left:0;right:0;height:50px;background:linear-gradient(to bottom,transparent,rgba(0,0,0,0.45))}
  .ecard-banner-Tech{background:linear-gradient(135deg,#312E81,#4F46E5,#7C3AED,#A855F7)}
  .ecard-banner-Sports{background:linear-gradient(135deg,#064E3B,#059669,#10B981,#A3E635)}
  .ecard-banner-Social{background:linear-gradient(135deg,#831843,#DB2777,#F472B6,#FB923C)}
  .ecard-banner-Education{background:linear-gradient(135deg,#1E3A8A,#2563EB,#60A5FA,#22D3EE)}
  .ecard-banner-Entrepreneurship{background:linear-gradient(135deg,#78350F,#D97706,#FB923C,#FCD34D)}

  /* Wavy ticket tear separator */
  .ecard-wave{width:100%;overflow:hidden;line-height:0;margin-top:-1px;position:relative;z-index:1}
  .ecard-wave svg{display:block;width:100%;height:18px}

  .ecard-head{position:relative;z-index:2;display:flex;justify-content:space-between;align-items:flex-start}
  .ctag{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:100px;font-size:10px;font-weight:700;background:rgba(255,255,255,0.18);color:#fff;backdrop-filter:blur(10px);letter-spacing:0.05em;text-transform:uppercase;border:1px solid rgba(255,255,255,0.15)}
  .badge-new{background:var(--lime);color:#0E0E12;padding:3px 9px;border-radius:100px;font-size:9px;font-weight:800;letter-spacing:0.06em;box-shadow:0 0 10px rgba(163,230,53,0.4)}

  /* Card body with subtle dot texture */
  .ecard-body{padding:14px 16px 0;flex:1;position:relative}
  .ecard-body::before{content:'';position:absolute;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,0.025) 1px,transparent 1px);background-size:18px 18px;pointer-events:none}
  .etitle{font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:800;margin-bottom:10px;line-height:1.25;letter-spacing:-0.4px;position:relative}
  .emeta{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;position:relative}
  .emr{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted2);font-weight:500}

  /* Participant bar */
  .cbar{height:4px;background:var(--bg4);border-radius:100px;margin-bottom:0;overflow:hidden;position:relative}
  .cfill{height:100%;border-radius:100px;transition:width 0.6s cubic-bezier(0.34,1.56,0.64,1)}
  .c-g{background:linear-gradient(90deg,#059669,#A3E635)}
  .c-a{background:linear-gradient(90deg,#D97706,#FB923C)}
  .c-o{background:linear-gradient(90deg,#EA580C,#F97316)}
  .c-r{background:linear-gradient(90deg,#DB2777,#F472B6)}

  /* Footer — full width join button */
  .ecard-footer{padding:12px 16px 16px;position:relative}
  .ecard-footer::before{content:'';position:absolute;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,0.025) 1px,transparent 1px);background-size:18px 18px;pointer-events:none}
  .ecnt-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .ecnt{font-size:11px;color:var(--muted);font-weight:600}
  .ecard-actions{display:flex;gap:8px;align-items:center}
  .join-full{flex:1}
  .share-btn{background:none;border:1px solid var(--border2);cursor:pointer;color:var(--muted2);font-size:13px;padding:7px 11px;border-radius:100px;transition:all 0.18s;display:flex;align-items:center}
  .share-btn:hover{color:var(--purple);border-color:rgba(168,85,247,0.4);background:rgba(168,85,247,0.08)}
  .trend-section{margin-bottom:32px}
  .trend-title{font-family:'Space Grotesk',sans-serif;font-size:20px;font-weight:800;margin-bottom:16px;display:flex;align-items:center;gap:8px;letter-spacing:-0.3px}
  .trend-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  .trend-card{background:var(--bg2);border:1px solid rgba(245,158,11,0.5);border-radius:var(--r);overflow:hidden;cursor:pointer;transition:transform 0.22s,box-shadow 0.22s;position:relative;animation:goldBreath 3s ease-in-out infinite}
  @keyframes goldBreath{
    0%,100%{box-shadow:0 0 10px rgba(245,158,11,0.2),0 0 20px rgba(245,158,11,0.1)}
    50%{box-shadow:0 0 22px rgba(245,158,11,0.55),0 0 44px rgba(245,158,11,0.25),0 0 60px rgba(245,158,11,0.08)}
  }
  .trend-card:hover{transform:translateY(-5px);box-shadow:0 0 30px rgba(245,158,11,0.6),0 0 60px rgba(245,158,11,0.3),0 16px 40px rgba(0,0,0,0.4)}
  .trend-rank{position:absolute;top:10px;right:10px;z-index:2;width:26px;height:26px;border-radius:50%;background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;font-family:'Space Grotesk',sans-serif;font-weight:800;font-size:12px;color:#fff}
  .trend-rank.r1{background:linear-gradient(135deg,#F59E0B,#FCD34D);color:#0E0E12}
  .trend-rank.r2{background:linear-gradient(135deg,#9CA3AF,#D1D5DB);color:#0E0E12}
  .trend-rank.r3{background:linear-gradient(135deg,#B45309,#D97706);color:#fff}
  /* FOOTER */
  .footer{margin-top:64px;border-top:1px solid var(--border);padding:48px 0 32px}
  .footer-inner{max-width:1200px;margin:0 auto;padding:0 20px}
  .footer-top{display:grid;grid-template-columns:1fr 1px 1fr;gap:0;margin-bottom:40px;align-items:center}
  .footer-brand{display:flex;flex-direction:column;gap:12px;padding-right:40px}
  .footer-logo{height:170px;width:auto;max-width:280px;object-fit:contain}
  .footer-tagline{font-size:13px;color:var(--muted);font-style:italic;line-height:1.6}
  .footer-copy{font-size:11px;color:var(--muted);margin-top:4px}
  .footer-contact{display:flex;flex-direction:column;gap:20px;padding-left:40px}
  .footer-contact-title{font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:700;color:var(--text);margin-bottom:6px;letter-spacing:-0.2px}
  .footer-contact-desc{font-size:12px;color:var(--muted2);line-height:1.6;margin-bottom:8px}
  .footer-email{display:inline-flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--border);color:var(--purple);font-size:12px;font-weight:600;padding:7px 14px;border-radius:100px;text-decoration:none;transition:all 0.18s;width:fit-content}
  .footer-email:hover{border-color:rgba(168,85,247,0.4);background:rgba(168,85,247,0.08)}
  .footer-divider{height:1px;background:var(--border);margin-bottom:28px}
  .footer-team-title{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin-bottom:16px;text-align:center}
  .footer-team{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
  .footer-member{display:flex;align-items:center;gap:8px;background:var(--bg2);border:1px solid var(--border);border-radius:100px;padding:6px 14px 6px 6px;transition:all 0.18s}
  .footer-member:hover{border-color:rgba(168,85,247,0.25)}
  .footer-member-avatar{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--purple),var(--pink));display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0}
  .footer-member-name{font-size:12px;font-weight:600;color:var(--muted2)}
  .footer-bottom{text-align:center;padding-top:20px;border-top:1px solid var(--border)}
  .footer-bottom-txt{font-size:11px;color:var(--muted)}
  @media(max-width:768px){
    .footer-top{grid-template-columns:1fr;gap:32px}
    .footer-brand{padding-right:0;align-items:center;text-align:center}
    .footer-contact{padding-left:0}
    .footer-team{gap:6px;flex-wrap:wrap}
    .footer-logo{height:150px;max-width:150px}
    .footer-divider-vert{display:none !important}
    .footer-email{align-self:center}
  }

  @media(max-width:768px){.trend-grid{grid-template-columns:1fr}}

  /* PRIVATE TOGGLE */
  .private-toggle{display:flex;align-items:center;justify-content:space-between;background:var(--bg3);border:1px solid var(--border);border-radius:14px;padding:14px 16px;margin-top:4px;cursor:pointer;transition:all 0.18s}
  .private-toggle:hover{border-color:rgba(168,85,247,0.3)}
  .private-toggle.on{border-color:rgba(168,85,247,0.4);background:rgba(168,85,247,0.06)}
  .toggle-left{display:flex;flex-direction:column;gap:3px}
  .toggle-label{font-size:13px;font-weight:700;color:var(--text)}
  .toggle-desc{font-size:11px;color:var(--muted)}
  .toggle-switch{width:42px;height:24px;border-radius:100px;background:var(--bg4);position:relative;transition:background 0.2s;flex-shrink:0}
  .toggle-switch.on{background:var(--purple);box-shadow:0 0 12px var(--glow-purple)}
  .toggle-switch::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform 0.2s;box-shadow:0 1px 4px rgba(0,0,0,0.3)}
  .toggle-switch.on::after{transform:translateX(18px)}

  /* REQUEST PANEL */
  .req-panel{margin-top:12px;background:var(--bg3);border-radius:16px;overflow:hidden;border:1px solid rgba(168,85,247,0.2)}
  .req-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;cursor:pointer;transition:background 0.16s}
  .req-header:hover{background:var(--bg4)}
  .req-title{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px}
  .req-num{background:rgba(168,85,247,0.15);color:var(--purple);padding:3px 9px;border-radius:100px;font-size:12px;font-weight:800}
  .req-list{padding:0 18px 14px;display:flex;flex-direction:column;gap:8px}
  .req-item{display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg2);border-radius:12px;border:1px solid var(--border)}
  .req-actions{display:flex;gap:6px;flex-shrink:0}
  .req-approve{background:rgba(163,230,53,0.12);color:var(--lime);border:1px solid rgba(163,230,53,0.25);padding:5px 12px;border-radius:100px;font-size:11px;font-weight:700;cursor:pointer;transition:all 0.16s}
  .req-approve:hover{background:rgba(163,230,53,0.22)}
  .req-reject{background:rgba(244,114,182,0.1);color:var(--pink);border:1px solid rgba(244,114,182,0.2);padding:5px 12px;border-radius:100px;font-size:11px;font-weight:700;cursor:pointer;transition:all 0.16s}
  .req-reject:hover{background:rgba(244,114,182,0.2)}

  /* PRIVATE BADGE ON CARD */
  .badge-private{background:rgba(168,85,247,0.15);color:var(--purple);border:1px solid rgba(168,85,247,0.3);padding:2px 8px;border-radius:100px;font-size:9px;font-weight:800;letter-spacing:0.06em}

  /* PROFILE HEADER */
  .profile-header{background:var(--bg2);border:1px solid var(--border);border-radius:24px;padding:24px;margin-bottom:24px;display:flex;align-items:center;gap:20px;position:relative;overflow:hidden}
  .profile-header::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 80% 60% at 0% 50%,rgba(168,85,247,0.07),transparent);pointer-events:none}
  .profile-avatar{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,var(--purple),var(--pink));display:flex;align-items:center;justify-content:center;font-family:'Space Grotesk',sans-serif;font-weight:800;font-size:26px;color:#fff;flex-shrink:0;box-shadow:0 0 24px var(--glow-purple)}
  .profile-info{flex:1;min-width:0}
  .profile-name{font-family:'Space Grotesk',sans-serif;font-weight:800;font-size:22px;letter-spacing:-0.5px;margin-bottom:3px}
  .profile-email{font-size:12px;color:var(--muted);margin-bottom:10px}
  .profile-stats{display:flex;gap:16px;flex-wrap:wrap}
  .profile-stat{display:flex;flex-direction:column;align-items:center;background:var(--bg3);border-radius:12px;padding:8px 16px;border:1px solid var(--border)}
  .profile-stat-num{font-family:'Space Grotesk',sans-serif;font-weight:800;font-size:20px;background:linear-gradient(135deg,var(--purple),var(--pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .profile-stat-lbl{font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-top:2px}
  .profile-badge{display:inline-flex;align-items:center;gap:5px;background:rgba(163,230,53,0.1);border:1px solid rgba(163,230,53,0.25);color:var(--lime);padding:4px 12px;border-radius:100px;font-size:11px;font-weight:700;margin-top:8px}
  @media(max-width:480px){.profile-header{flex-direction:column;text-align:center}.profile-stats{justify-content:center}}

  /* EDIT PANEL */
  .edit-panel{margin-top:20px;background:var(--bg3);border-radius:16px;overflow:hidden;border:1px solid rgba(163,230,53,0.2)}
  .edit-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;cursor:pointer;transition:background 0.16s}
  .edit-header:hover{background:var(--bg4)}
  .edit-title{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;color:var(--lime)}
  .edit-body{padding:0 18px 18px;display:flex;flex-direction:column;gap:12px}

  /* PARTICIPANTS PANEL */
  .part-panel{margin-top:20px;background:var(--bg3);border-radius:16px;overflow:hidden;border:1px solid var(--border)}
  .part-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;cursor:pointer;transition:background 0.16s}
  .part-header:hover{background:var(--bg4)}
  .part-title{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px}
  .part-list{padding:0 18px 14px;display:flex;flex-direction:column;gap:8px}
  .part-item{display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg2);border-radius:12px;border:1px solid var(--border)}
  .part-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--purple),var(--pink));display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#fff;flex-shrink:0}
  .part-name{font-weight:600;font-size:13px;margin-bottom:2px}
  .part-email{font-size:11px;color:var(--muted);font-weight:400}
  .part-num{font-family:'Space Grotesk',sans-serif;font-weight:800;font-size:13px;color:var(--purple);background:rgba(168,85,247,0.1);padding:3px 9px;border-radius:100px}

  /* BUTTONS */
  .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 18px;border-radius:100px;font-family:'Inter',sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.18s;border:none;letter-spacing:0.01em}
  .btn:disabled{opacity:.4;cursor:not-allowed}
  .bp{background:var(--lime);color:#0E0E12}
  .bp:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 20px var(--glow-lime)}
  .bo{background:none;border:1.5px solid var(--border2);color:var(--text)}
  .bo:hover{border-color:rgba(168,85,247,0.5);color:var(--purple)}
  .bg{background:var(--bg3);color:var(--muted2)}.bg:hover{background:var(--bg4);color:var(--text)}
  .bd{background:rgba(244,114,182,0.1);color:var(--pink);border:1px solid rgba(244,114,182,0.2)}.bd:hover{background:rgba(244,114,182,0.18)}
  .bf{background:var(--bg3);color:var(--muted);cursor:not-allowed;border:none}
  .bsm{padding:5px 12px;font-size:11px;border-radius:100px}
  .blg{padding:13px 28px;font-size:15px;border-radius:100px;font-weight:700}

  /* PAGINATION */
  .pages{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:32px}
  .pg{width:36px;height:36px;border-radius:10px;background:var(--bg3);border:1px solid var(--border);color:var(--muted2);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.18s;font-weight:600}
  .pg:hover:not(:disabled){border-color:rgba(168,85,247,0.4);color:var(--purple)}
  .pg.on{background:var(--purple);border-color:var(--purple);color:#fff;box-shadow:0 0 16px var(--glow-purple)}
  .pg:disabled{opacity:.3;cursor:not-allowed}

  /* DETAIL CARD */
  .dcard{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
  .dcard-banner{height:160px;position:relative}
  .dcard-banner-Tech{background:linear-gradient(135deg,#4F46E5,#7C3AED,#A855F7)}
  .dcard-banner-Sports{background:linear-gradient(135deg,#059669,#10B981,#A3E635)}
  .dcard-banner-Social{background:linear-gradient(135deg,#DB2777,#F472B6,#FB923C)}
  .dcard-banner-Education{background:linear-gradient(135deg,#2563EB,#60A5FA,#22D3EE)}
  .dcard-banner-Entrepreneurship{background:linear-gradient(135deg,#D97706,#FB923C,#FCD34D)}
  .dcard-banner::after{content:'';position:absolute;inset:0;background:linear-gradient(to bottom,transparent,rgba(22,22,28,0.8))}
  .dcard-banner-inner{position:absolute;bottom:0;left:0;right:0;padding:20px 24px;z-index:1;display:flex;justify-content:space-between;align-items:flex-end}
  .dcard-body{padding:24px}
  .dtitle{font-family:'Space Grotesk',sans-serif;font-size:clamp(22px,4vw,36px);font-weight:800;line-height:1.15;margin-bottom:20px;letter-spacing:-0.5px}
  .dgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:22px}
  .di{background:var(--bg3);border-radius:14px;padding:13px 16px;border:1px solid var(--border)}
  .di-l{font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);margin-bottom:5px;font-weight:600}
  .di-v{font-size:13px;font-weight:600;line-height:1.4;color:var(--text)}
  .ddesc{color:var(--muted2);line-height:1.8;font-size:14px}

  /* MODAL */
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(12px);z-index:200;display:flex;align-items:center;justify-content:center;padding:18px;animation:fadeIn 0.15s ease}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  .modal{background:var(--bg2);border:1px solid var(--border2);border-radius:24px;padding:32px 28px;width:100%;max-width:400px;animation:slideUp 0.22s ease;box-shadow:0 24px 80px rgba(0,0,0,0.5)}
  @keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
  .mhead{text-align:center;margin-bottom:24px}
  .mhead h2{font-family:'Space Grotesk',sans-serif;font-size:24px;font-weight:800;margin-bottom:4px;letter-spacing:-0.5px}
  .mhead p{color:var(--muted2);font-size:13px}
  .fg{margin-bottom:14px}
  .fl{font-size:11px;font-weight:600;color:var(--muted2);margin-bottom:6px;display:block;text-transform:uppercase;letter-spacing:0.06em}
  .fi{width:100%;background:var(--bg3);border:1.5px solid var(--border);border-radius:12px;padding:11px 14px;color:var(--text);font-family:'Inter',sans-serif;font-size:14px;outline:none;transition:all 0.18s}
  .fi:focus{border-color:rgba(168,85,247,0.5);box-shadow:0 0 0 3px rgba(168,85,247,0.08)}
  .fi::placeholder{color:var(--muted)} select.fi option{background:var(--bg2)}
  .ferr{color:var(--pink);font-size:12px;margin-top:10px;text-align:center;font-weight:500}
  .fsw{text-align:center;margin-top:14px;font-size:13px;color:var(--muted)}
  .fsw button{background:none;border:none;color:var(--purple);font-weight:700;cursor:pointer}

  /* CREATE FORM */
  .ccard{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:32px;max-width:660px;margin:0 auto}
  .f2{display:grid;grid-template-columns:1fr 1fr;gap:14px} .s2{grid-column:span 2}

  /* TABS */
  .tabs{display:flex;gap:4px;background:var(--bg3);border-radius:14px;padding:4px;width:fit-content;margin-bottom:24px}
  .tab{background:none;border:none;color:var(--muted);font-family:'Inter',sans-serif;font-size:13px;font-weight:600;padding:7px 18px;border-radius:10px;cursor:pointer;transition:all 0.18s}
  .tab.on{background:var(--bg4);color:var(--text);box-shadow:0 2px 8px rgba(0,0,0,0.2)}

  /* EMPTY */
  .empty{text-align:center;padding:64px 18px;color:var(--muted)}
  .eico{font-size:48px;margin-bottom:12px;display:block}
  .empty h3{font-family:'Space Grotesk',sans-serif;font-size:20px;font-weight:700;color:var(--text);margin-bottom:7px}
  .empty p{font-size:13px;line-height:1.65;max-width:280px;margin:0 auto}

  /* TOAST */
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:300;background:var(--bg2);border:1px solid var(--border2);border-radius:100px;padding:12px 20px;display:flex;align-items:center;gap:9px;box-shadow:0 8px 32px rgba(0,0,0,0.5);animation:tin 0.22s ease;font-size:13px;font-weight:500;white-space:nowrap}
  @keyframes tin{from{opacity:0;transform:translateX(-50%) translateY(12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
  .toast.ok{border-color:rgba(163,230,53,0.3);color:var(--lime)}
  .toast.err{border-color:rgba(244,114,182,0.3);color:var(--pink)}

  /* MISC */
  .back{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:13px;cursor:pointer;margin-bottom:20px;background:none;border:none;font-family:'Inter',sans-serif;transition:color 0.16s;font-weight:500}
  .back:hover{color:var(--text)}
  .hr{height:1px;background:var(--border);margin:20px 0}
  .stitle{font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:700;margin-bottom:14px;letter-spacing:-0.3px}
  .spinner{width:36px;height:36px;border:3px solid var(--bg4);border-top-color:var(--purple);border-radius:50%;animation:spin 0.7s linear infinite;margin:56px auto;display:block}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* FOOTER */
  .footer{margin-top:64px;border-top:1px solid var(--border);padding:48px 0 32px}
  .footer-inner{max-width:1200px;margin:0 auto;padding:0 20px}
  .footer-top{display:grid;grid-template-columns:1fr 1px 1fr;gap:0;margin-bottom:40px;align-items:center}
  .footer-brand{display:flex;flex-direction:column;gap:12px;padding-right:40px}
  .footer-logo{height:170px;width:auto;max-width:280px;object-fit:contain}
  .footer-tagline{font-size:13px;color:var(--muted);font-style:italic;line-height:1.6}
  .footer-copy{font-size:11px;color:var(--muted);margin-top:4px}
  .footer-contact{display:flex;flex-direction:column;gap:20px;padding-left:40px}
  .footer-contact-title{font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:700;color:var(--text);margin-bottom:6px;letter-spacing:-0.2px}
  .footer-contact-desc{font-size:12px;color:var(--muted2);line-height:1.6;margin-bottom:8px}
  .footer-email{display:inline-flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--border);color:var(--purple);font-size:12px;font-weight:600;padding:7px 14px;border-radius:100px;text-decoration:none;transition:all 0.18s;width:fit-content}
  .footer-email:hover{border-color:rgba(168,85,247,0.4);background:rgba(168,85,247,0.08)}
  .footer-divider{height:1px;background:var(--border);margin-bottom:28px}
  .footer-team-title{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin-bottom:16px;text-align:center}
  .footer-team{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
  .footer-member{display:flex;align-items:center;gap:8px;background:var(--bg2);border:1px solid var(--border);border-radius:100px;padding:6px 14px 6px 6px;transition:all 0.18s}
  .footer-member:hover{border-color:rgba(168,85,247,0.25)}
  .footer-member-avatar{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--purple),var(--pink));display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0}
  .footer-member-name{font-size:12px;font-weight:600;color:var(--muted2)}
  .footer-bottom{text-align:center;padding-top:20px;border-top:1px solid var(--border)}
  .footer-bottom-txt{font-size:11px;color:var(--muted)}
  @media(max-width:768px){
    .footer-top{grid-template-columns:1fr;gap:32px}
    .footer-brand{padding-right:0;align-items:center;text-align:center}
    .footer-contact{padding-left:0}
    .footer-team{gap:6px;flex-wrap:wrap}
    .footer-logo{height:150px;max-width:150px}
    .footer-divider-vert{display:none !important}
    .footer-email{align-self:center}
  }

  @media(max-width:768px){
    .nav-links{display:flex;gap:2px;flex-wrap:wrap;justify-content:center}.ham{display:none}
    .grid{grid-template-columns:1fr}
    .dgrid{grid-template-columns:1fr}
    .f2{grid-template-columns:1fr}.s2{grid-column:span 1}
    .stats{gap:8px}.scard{padding:10px 14px}
    .ccard{padding:20px 16px}.dcard-body{padding:18px 16px}
    .hero-split{grid-template-columns:1fr}
    .hero-left{border-right:none;border-bottom:none;padding:20px 16px}
    .hero-logo{height:320px;max-width:85%}
    .hero-right{padding:20px 24px}
    .hero h1{letter-spacing:-1px}
  }
  @media(max-width:480px){
    .hero h1{font-size:28px}
    .blg{padding:12px 22px;font-size:14px}
    .toast{left:16px;right:16px;bottom:16px;transform:none;border-radius:16px;white-space:normal}
    @keyframes tin{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
    .nav-inner{height:auto;padding:10px 16px;flex-wrap:wrap;gap:6px}
    .nb{font-size:11px;padding:5px 10px}
  }
`;

// ─── Share Utility ────────────────────────────────────────────────────────────
function shareEvent(eventId, title) {
  const url = `${window.location.origin}${window.location.pathname}?event=${eventId}`;
  if (navigator.share) {
    navigator.share({ title: `UniVibe: ${title}`, url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(() => {}).catch(() => {});
  }
  return url;
}

// ─── Small Components ─────────────────────────────────────────────────────────
function Toast({ msg, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3200); return () => clearTimeout(t); }, [onClose]);
  return <div className={`toast ${type === "error" ? "err" : "ok"}`}><span>{type === "error" ? "❌" : "✅"}</span><span>{msg}</span></div>;
}
function Spinner() { return <div className="spinner" />; }
function CBar({ count, max }) {
  const p = capPct(count, max);
  const cls = p >= 100 ? "c-r" : p >= 80 ? "c-o" : p >= 50 ? "c-a" : "c-g";
  return <div className="cbar"><div className={`cfill ${cls}`} style={{ width:`${p}%` }} /></div>;
}
function CTag({ cat }) { return <span className="ctag">{CAT_ICON[cat] || ""} {cat}</span>; }

function JoinBtn({ event, user, onAction }) {
  const [joined,  setJoined]  = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!user) { setJoined(false); return; }
    db.isJoined(event.id, user.id).then(setJoined);
  }, [event.id, user]);
  const full  = event.attendee_count >= event.max_participants;
  const click = async e => {
    e.stopPropagation();
    if (!user) { onAction("auth"); return; }
    setLoading(true);
    const r = joined ? await db.leaveEvent(event.id, user.id) : await db.joinEvent(event.id, user.id);
    setLoading(false);
    if (r.error) { onAction("error:" + r.error); return; }
    setJoined(!joined);
    onAction(joined ? "left" : "joined");
  };
  if (loading)         return <button className="btn bf bsm" disabled>…</button>;
  if (full && !joined) return <button className="btn bf bsm" disabled>Full</button>;
  if (joined)          return <button className="btn bd bsm" onClick={click}>Leave</button>;
  return                      <button className="btn bp bsm" onClick={click}>Join ✦</button>;
}

function JoinBtnFull({ event, user, onAction }) {
  const [joined,    setJoined]    = useState(false);
  const [reqStatus, setReqStatus] = useState(null);
  const [loading,   setLoading]   = useState(false);

  useEffect(() => {
    if (!user) { setJoined(false); setReqStatus(null); return; }
    if (event.is_private) {
      db.getRequestStatus(event.id, user.id).then(s => {
        setReqStatus(s);
        setJoined(s === "approved");
      });
    } else {
      db.isJoined(event.id, user.id).then(setJoined);
    }
  }, [event.id, event.is_private, user]);

  const full = event.attendee_count >= event.max_participants;
  const base = { width:"100%", justifyContent:"center", borderRadius:14, padding:"10px 0", fontSize:13, fontWeight:700, letterSpacing:"0.02em" };
  const privBase = { ...base, background:"rgba(168,85,247,0.12)", color:"var(--purple)", border:"1px solid rgba(168,85,247,0.3)" };

  const click = async e => {
    e.stopPropagation();
    if (!user) { onAction("auth"); return; }
    setLoading(true);

    if (event.is_private) {
      if (joined) {
        // Leave approved event
        const r = await db.leaveEvent(event.id, user.id);
        if (!r.error) { setJoined(false); setReqStatus(null); onAction("left"); }
        else onAction("error:" + r.error);
      } else if (reqStatus === "pending") {
        // Cancel pending request
        await db.cancelRequest(event.id, user.id);
        setReqStatus(null);
      } else {
        // Send request
        const r = await db.requestJoin(event.id, user.id);
        if (!r.error || r.error === "already_requested") setReqStatus("pending");
        else onAction("error:" + r.error);
      }
    } else {
      const r = joined ? await db.leaveEvent(event.id, user.id) : await db.joinEvent(event.id, user.id);
      if (r.error) { onAction("error:" + r.error); setLoading(false); return; }
      setJoined(!joined);
      onAction(joined ? "left" : "joined");
    }
    setLoading(false);
  };

  if (loading) return <button className="btn bf" style={base} disabled>…</button>;

  // Private event states
  if (event.is_private) {
    if (joined)              return <button className="btn bd" style={base} onClick={click}>✓ Going · Leave</button>;
    if (reqStatus === "pending") return <button style={privBase} onClick={click}>⏳ Pending · Cancel</button>;
    if (full)                return <button className="btn bf" style={base} disabled>Event Full</button>;
    return                          <button style={privBase} onClick={click}>🔒 Request to Join</button>;
  }

  // Public event states
  if (full && !joined) return <button className="btn bf" style={base} disabled>Event Full</button>;
  if (joined)          return <button className="btn bd" style={base} onClick={click}>✓ Going · Leave</button>;
  return                      <button className="btn bp" style={base} onClick={click}>✦ Join Event</button>;
}

function ECard({ event, user, onSelect, onAction }) {
  const isNew     = Date.now() - new Date(event.created_at).getTime() < 172800000;
  const isHost    = user && event.host_id === user.id;
  const isAdmin   = user && user.email === ADMIN_EMAIL;
  const canDelete = isHost || isAdmin;
  const pct       = capPct(event.attendee_count, event.max_participants);
  const barCls    = pct >= 100 ? "c-r" : pct >= 80 ? "c-o" : pct >= 50 ? "c-a" : "c-g";

  const handleDelete = async e => {
    e.stopPropagation();
    if (!window.confirm("Delete this event?")) return;
    const r = await db.deleteEvent(event.id);
    if (r.error) { onAction("error:" + r.error); return; }
    onAction("deleted");
  };

  return (
    <div className="ecard" onClick={() => onSelect(event)} role="button" tabIndex={0} onKeyDown={e => e.key === "Enter" && onSelect(event)}>
      <div className={`ecard-banner ecard-banner-${event.category}`}>
        <div className="ecard-head">
          <CTag cat={event.category} />
          <div style={{ display:"flex", gap:5, alignItems:"center" }}>
            {event.is_private && <span className="badge-private">🔒 PRIVATE</span>}
            {isNew && <span className="badge-new">NEW</span>}
            {canDelete && (
              <button className="btn bsm" onClick={handleDelete}
                style={{ fontSize:10, padding:"3px 9px", background:"rgba(0,0,0,0.4)", color:"#fff", border:"1px solid rgba(255,255,255,0.2)", backdropFilter:"blur(8px)", borderRadius:100 }}>
                🗑
              </button>
            )}
          </div>
        </div>
        <div style={{ position:"relative", zIndex:2, paddingBottom:8 }}>
          <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:800, fontSize:17, color:"#fff", lineHeight:1.2, letterSpacing:"-0.3px", textShadow:"0 2px 12px rgba(0,0,0,0.5)" }}>
            {trunc(event.title, 55)}
          </div>
        </div>
      </div>
      <div className="ecard-wave">
        <svg viewBox="0 0 400 18" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M0,0 C20,18 40,0 60,9 C80,18 100,0 120,9 C140,18 160,0 180,9 C200,18 220,0 240,9 C260,18 280,0 300,9 C320,18 340,0 360,9 C380,18 400,0 400,0 L400,18 L0,18 Z" fill="#16161C"/>
        </svg>
      </div>
      <div className="ecard-body">
        <div className="emeta">
          <div className="emr">📅 {fmtDate(event.date)} · {fmtTime(event.date)}</div>
          <div className="emr">📍 {trunc(event.location, 60)}</div>
          <div className="emr">👤 {trunc(event.host_name, 40)}</div>
        </div>
      </div>
      <div className="ecard-footer">
        <div className="ecnt-row">
          <span className="ecnt">{event.attendee_count}/{event.max_participants} going</span>
          <span style={{ fontSize:11, color:"var(--muted)", fontWeight:600 }}>{pct}% full</span>
        </div>
        <div className="cbar" style={{ marginBottom:12 }}><div className={`cfill ${barCls}`} style={{ width:`${pct}%` }} /></div>
        <div className="ecard-actions">
          <div className="join-full" onClick={e => e.stopPropagation()}>
            <JoinBtnFull event={event} user={user} onAction={onAction} />
          </div>
          <button className="share-btn" onClick={e => { e.stopPropagation(); shareEvent(event.id, event.title); onAction("share"); }} title="Share">🔗</button>
        </div>
      </div>
    </div>
  );
}

// ─── Auth Modal ───────────────────────────────────────────────────────────────
function DoneScreen({ email, password, onAuth, onClose }) {
  const [attempt,  setAttempt]  = useState(0);
  const [showManual, setShowManual] = useState(false);
  const [trying,   setTrying]   = useState(false);
  const [dots,     setDots]     = useState(".");
  const name = nameFromEmail(email);

  // Animate dots
  useEffect(() => {
    const t = setInterval(() => setDots(d => d.length >= 3 ? "." : d + "."), 500);
    return () => clearInterval(t);
  }, []);

  // Auto retry every 5 seconds, show manual button after 60s
  useEffect(() => {
    const t = setTimeout(() => {
      if (attempt >= 12) { setShowManual(true); return; } // 12 * 5s = 60s
      trySignIn();
    }, attempt === 0 ? 3000 : 5000); // first try after 3s, then every 5s
    return () => clearTimeout(t);
  }, [attempt]);

  const trySignIn = async () => {
    setTrying(true);
    const r = await db.signIn(email, password);
    setTrying(false);
    if (!r.error) { onAuth(r.data); onClose(); return; }
    setAttempt(a => a + 1);
  };

  const messages = [
    "Setting up your account",
    "Verifying your KIU email",
    "Almost there",
    "Just a moment",
    "Preparing your profile",
  ];
  const msg = messages[attempt % messages.length];

  return (
    <div style={{ textAlign:"center", padding:"8px 0 20px" }}>
      <div style={{ fontSize:52, marginBottom:14 }}>🎓</div>
      <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:800, fontSize:20, marginBottom:8 }}>
        Welcome to UniVibe, {name}!
      </div>
      <div style={{ color:"var(--muted2)", fontSize:13, lineHeight:1.75, marginBottom:28 }}>
        Your account has been created.<br/>
        We're signing you in automatically.
      </div>

      {/* Pulsing orb */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:12, marginBottom:20 }}>
        <div style={{ display:"flex", gap:6 }}>
          {[0,1,2].map(i => (
            <div key={i} style={{
              width:10, height:10, borderRadius:"50%",
              background:"var(--purple)",
              animation:`pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
              opacity: trying ? 1 : 0.4,
            }} />
          ))}
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(0.7); opacity: 0.3; }
          50% { transform: scale(1.2); opacity: 1; }
        }
      `}</style>

      <div style={{ color:"var(--muted)", fontSize:12, marginBottom:24, minHeight:18 }}>
        {showManual ? "Taking longer than expected…" : `${msg}${dots}`}
      </div>

      {showManual && (
        <button className="btn bp" style={{ width:"100%", justifyContent:"center", borderRadius:14, padding:"13px 0", fontSize:15 }}
          onClick={trySignIn} disabled={trying}>
          {trying ? "Signing in…" : "Sign In Now →"}
        </button>
      )}
    </div>
  );
}

function AuthModal({ onClose, onAuth }) {
  const [mode,     setMode]    = useState("login");
  const [form,     setForm]    = useState({ email:"", password:"", confirm:"" });
  const [error,    setError]   = useState("");
  const [loading,  setLoading] = useState(false);
  const [done,     setDone]    = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const previewName = form.email.endsWith("@kiu.edu.ge") ? nameFromEmail(form.email) : "";

  const go = async () => {
    setError("");
    if (mode === "signup") {
      if (!form.email.endsWith("@kiu.edu.ge")) { setError("Only KIU university emails (@kiu.edu.ge) are allowed."); return; }
      if (form.password.length < 6) { setError("Password must be at least 6 characters."); return; }
      if (form.password !== form.confirm) { setError("Passwords don't match. Please try again."); return; }
    }
    setLoading(true);
    const r = mode === "login"
      ? await db.signIn(form.email, form.password)
      : await db.signUp(form.email, form.password);
    setLoading(false);
    if (r.error) { setError(r.error); return; }
    if (r.data === "verify") { setDone(true); return; }
    onAuth(r.data); onClose();
  };

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="mhead">
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center", marginBottom:12 }}>
            <img src="https://pub-d2b9c326a58845019dfb974ae3ee9e9a.r2.dev/univibelogo.png" alt="UniVibe" style={{ height:200, width:"auto" }} />
          </div>
          {!done && <h2>{mode === "login" ? "Welcome back" : "Join UniVibe"}</h2>}
          {!done && <p>{mode === "login" ? "Sign in to your KIU account" : "Create your campus account"}</p>}
        </div>

        {done ? (
          <DoneScreen email={form.email} password={form.password} onAuth={onAuth} onClose={onClose} />
        ) : (
          <>
            <div className="fg">
              <label className="fl">KIU Email</label>
              <input className="fi" type="email" placeholder="you@kiu.edu.ge" value={form.email}
                onChange={e => set("email", e.target.value)} maxLength={200} autoComplete="email" />
              {previewName && mode === "signup" && (
                <div style={{ marginTop:6, fontSize:11, color:"var(--purple)", fontWeight:600, display:"flex", alignItems:"center", gap:5 }}>
                  <span>✦</span> Your name on UniVibe: <strong>{previewName}</strong>
                </div>
              )}
            </div>
            <div className="fg">
              <label className="fl">Password</label>
              <input className="fi" type="password" placeholder="••••••••" value={form.password}
                onChange={e => set("password", e.target.value)}
                onKeyDown={e => e.key === "Enter" && mode === "login" && !loading && go()}
                maxLength={200} autoComplete={mode === "login" ? "current-password" : "new-password"} />
            </div>
            {mode === "signup" && (
              <div className="fg">
                <label className="fl">Confirm Password</label>
                <input className="fi" type="password" placeholder="••••••••" value={form.confirm}
                  onChange={e => set("confirm", e.target.value)}
                  onKeyDown={e => e.key === "Enter" && !loading && go()}
                  maxLength={200} autoComplete="new-password" />
                {form.confirm && (
                  <div style={{ marginTop:6, fontSize:11, fontWeight:600, color: form.password === form.confirm ? "var(--lime)" : "var(--pink)", display:"flex", alignItems:"center", gap:4 }}>
                    {form.password === form.confirm ? "✓ Passwords match" : "✗ Passwords don't match"}
                  </div>
                )}
              </div>
            )}
            {error && <div className="ferr">{error}</div>}
            <button className="btn bp" style={{ width:"100%", justifyContent:"center", marginTop:18, borderRadius:14, padding:"13px 0", fontSize:15 }}
              onClick={go} disabled={loading}>
              {loading ? "Please wait…" : mode === "login" ? "Sign In →" : "Create Account →"}
            </button>
            <div className="fsw">
              {mode === "login"
                ? <>No account? <button onClick={() => { setMode("signup"); setError(""); setForm({ email:form.email, password:"", confirm:"" }); }}>Sign up free</button></>
                : <>Have an account? <button onClick={() => { setMode("login"); setError(""); setForm({ email:form.email, password:"", confirm:"" }); }}>Sign in</button></>
              }
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Trending Section ─────────────────────────────────────────────────────────
function TrendingSection({ user, onSelect, onShowAuth, onRefresh }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const data = await db.getTrending();
      setEvents(data); setLoading(false);
    })();
  }, []);

  if (loading || events.length === 0) return null;

  const rankClass = ["r1","r2","r3"];
  const rankLabel = ["🥇","🥈","🥉"];

  return (
    <div className="trend-section">
      <div className="trend-title">🔥 Trending on Campus</div>
      <div className="trend-grid">
        {events.map((event, i) => (
          <div key={event.id} className="trend-card" onClick={() => onSelect(event)}>
            <div className={`ecard-banner ecard-banner-${event.category}`} style={{ height:70 }}>
              <div className="ecard-head" style={{ padding:"10px 12px" }}>
                <CTag cat={event.category} />
              </div>
            </div>
            <div className={`trend-rank ${rankClass[i]}`}>{i+1}</div>
            <div style={{ padding:"12px 14px 14px" }}>
              <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:700, fontSize:15, marginBottom:8, lineHeight:1.3 }}>{trunc(event.title, 60)}</div>
              <div style={{ fontSize:11, color:"var(--muted2)", marginBottom:10 }}>📅 {fmtDate(event.date)} · 📍 {trunc(event.location, 40)}</div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                  <span style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:800, fontSize:18, background:"linear-gradient(135deg,var(--purple),var(--pink))", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>{event.attendee_count}</span>
                  <span style={{ fontSize:11, color:"var(--muted)" }}>/ {event.max_participants} joined</span>
                </div>
                <button className="share-btn" onClick={e => { e.stopPropagation(); shareEvent(event.id, event.title); onRefresh("ok", "Link copied! 🔗"); }} title="Copy link">🔗</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Home Page ────────────────────────────────────────────────────────────────
function HomePage({ user, onSelect, onRefresh, onShowAuth }) {
  const [cat, setCat]         = useState("All");
  const [search, setSearch]   = useState("");
  const [page, setPage]       = useState(0);
  const [events, setEvents]   = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [stats, setStats]     = useState({ totalEvents:0, totalJoins:0, topCategory:"—" });

  const load = useCallback(async () => {
    setLoading(true);
    const [evRes, stRes] = await Promise.all([db.getEvents(cat, page, search), db.getStats()]);
    setEvents(evRes.data); setTotal(evRes.total); setStats(stRes);
    setLoading(false);
  }, [cat, page, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [cat, search]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const act = useCallback(async a => {
    if (a === "auth")           { onShowAuth(); return; }
    if (a === "share")          { onRefresh("ok", "Link copied! 🔗"); return; }
    if (a === "deleted")        { await load(); onRefresh("ok", "Event deleted."); return; }
    if (a.startsWith("error:")) { onRefresh("error", a.slice(6)); return; }
    await load(); onRefresh("ok", a === "joined" ? "Joined! 🎉" : "Left event.");
  }, [load, onRefresh, onShowAuth]);

  return (
    <div className="page"><div className="container">
      <div className="hero">
        <div className="hero-split">
          {/* LEFT — Big Logo */}
          <div className="hero-left">
            <img
              src="https://pub-d2b9c326a58845019dfb974ae3ee9e9a.r2.dev/univibelogo.png"
              alt="UniVibe"
              className="hero-logo"
            />
          </div>
          {/* RIGHT — Text + Stats */}
          <div className="hero-right">
            <div className="hero-badge">🎓 UniVibe · Your campus social</div>
            <h1>Where campus<br /><em>comes alive</em></h1>
            <p>Discover events, meet people, and make university actually worth it.</p>
            <div className="hero-btns">
              <button className="btn bp blg" onClick={() => user ? onSelect("create") : onShowAuth()}>✦ Host an Event</button>
              <button className="btn bo blg" onClick={() => document.getElementById("feed")?.scrollIntoView({ behavior:"smooth" })}>Explore Events ↓</button>
            </div>
            <div className="stats">
              <div className="scard"><div className="snum">{stats.totalEvents}</div><div className="slbl">Events</div></div>
              <div className="scard"><div className="snum">{stats.totalJoins}</div><div className="slbl">RSVPs</div></div>
              <div className="scard"><div className="snum">{VALID_CATS.length}</div><div className="slbl">Categories</div></div>
              <div className="scard"><div className="snum">{CAT_ICON[stats.topCategory] || "—"}</div><div className="slbl">{stats.topCategory !== "—" ? stats.topCategory : "No events yet"}</div></div>
            </div>
          </div>
        </div>
      </div>
      <TrendingSection user={user} onSelect={onSelect} onShowAuth={onShowAuth} onRefresh={onRefresh} />
      <div id="feed">
        <div className="stitle">✨ All Events</div>
        <div className="sbar">
          <span style={{ color:"var(--muted)", fontSize:13 }}>🔍</span>
          <input placeholder="Search events, locations…" value={search} onChange={e => setSearch(e.target.value)} maxLength={200} />
          {search && <button className="sbar-x" onClick={() => setSearch("")}>×</button>}
        </div>
        <div className="filters">{ALL_CATS.map(c => <button key={c} className={`pill ${cat===c?"on":""}`} onClick={() => setCat(c)}>{c !== "All" ? CAT_ICON[c]+" " : ""}{c}</button>)}</div>
        {loading ? <Spinner />
          : events.length === 0
          ? <div className="empty"><div className="eico">🔭</div><h3>No events yet</h3><p>{search || cat !== "All" ? "Try a different filter." : "Be the first to create an event!"}</p></div>
          : <div className="grid">{events.map(e => <ECard key={e.id} event={e} user={user} onSelect={onSelect} onAction={act} />)}</div>
        }
        {!loading && pages > 1 && (
          <div className="pages">
            <button className="pg" onClick={() => setPage(p => p-1)} disabled={page===0}>‹</button>
            {[...Array(pages)].map((_,i) => <button key={i} className={`pg ${i===page?"on":""}`} onClick={() => setPage(i)}>{i+1}</button>)}
            <button className="pg" onClick={() => setPage(p => p+1)} disabled={page>=pages-1}>›</button>
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-top">

            {/* Brand */}
            <div className="footer-brand">
              <img src="https://pub-d2b9c326a58845019dfb974ae3ee9e9a.r2.dev/univibelogo.png" alt="UniVibe" className="footer-logo" />
              <div className="footer-tagline">"Where campus comes alive."</div>
              <div className="footer-copy">© 2026 UniVibe · Kutaisi International University</div>
            </div>

            {/* Divider */}
            <div className="footer-divider-vert" style={{ width:1, background:"var(--border)", alignSelf:"stretch", minHeight:120 }} />

            {/* Contact */}
            <div className="footer-contact">
              <div>
                <div className="footer-contact-title">⚙️ Ideas, Feedback & Support</div>
                <div className="footer-contact-desc">Got a feature idea, found a bug, or want to suggest an improvement? We're always listening.</div>
                <a className="footer-email" href="mailto:chichinadze.saba@kiu.edu.ge">✉ chichinadze.saba@kiu.edu.ge</a>
              </div>
              <div>
                <div className="footer-contact-title">🤝 Collaborations & Partnerships</div>
                <div className="footer-contact-desc">Want to bring UniVibe to your organization or explore working together?</div>
                <a className="footer-email" href="mailto:dvali.marita@kiu.edu.ge">✉ dvali.marita@kiu.edu.ge</a>
              </div>
            </div>

          </div>

          <div className="footer-divider" />

          {/* Team */}
          <div className="footer-team-title">Built with 🖤 by the UniVibe Team</div>
          <div className="footer-team">
            {[
              { name:"Saba Chichinadze",    init:"SC" },
              { name:"Elisabed Kobiashvili", init:"EK" },
              { name:"Marita Dvali",         init:"MD" },
              { name:"Gio Sagaradze",        init:"GS" },
              { name:"Sesili Kasrashvili",   init:"SK" },
              { name:"Mishiko Gogsadze",     init:"MG" },
            ].map(m => (
              <div key={m.name} className="footer-member">
                <div className="footer-member-avatar">{m.init}</div>
                <span className="footer-member-name">{m.name}</span>
              </div>
            ))}
          </div>

          <div className="footer-bottom" style={{ marginTop:24 }}>
            <a href="https://www.instagram.com/univibe_kiu/" target="_blank" rel="noopener noreferrer"
              style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:40, height:40, borderRadius:12,
                background:"linear-gradient(135deg,#833AB4,#C13584,#E1306C,#F77737)",
                marginBottom:16, transition:"all 0.2s", boxShadow:"0 0 0 rgba(193,53,132,0)" }}
              onMouseEnter={e => e.currentTarget.style.cssText += ";transform:scale(1.12);box-shadow:0 0 20px rgba(193,53,132,0.5)"}
              onMouseLeave={e => { e.currentTarget.style.transform="scale(1)"; e.currentTarget.style.boxShadow="0 0 0 rgba(193,53,132,0)"; }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="20" height="20" rx="5" stroke="white" strokeWidth="2"/>
                <circle cx="12" cy="12" r="4.5" stroke="white" strokeWidth="2"/>
                <circle cx="17.5" cy="6.5" r="1" fill="white"/>
              </svg>
            </a>
            <div className="footer-bottom-txt">Made in Georgia 🇬🇪 · univibe.ge</div>
          </div>

        </div>
      </footer>

    </div></div>
  );
}

// ─── Detail Page ──────────────────────────────────────────────────────────────
function DetailPage({ eventId, user, onBack, onShowAuth, onRefresh }) {
  const [event,        setEvent]        = useState(null);
  const [joined,       setJoined]       = useState(false);
  const [reqStatus,    setReqStatus]    = useState(null); // null | pending | approved | rejected
  const [loading,      setLoading]      = useState(true);
  const [acting,       setActing]       = useState(false);
  const [deleting,     setDeleting]     = useState(false);
  const [showParts,    setShowParts]    = useState(false);
  const [participants, setParticipants] = useState([]);
  const [partsLoading, setPartsLoading] = useState(false);
  const [showReqs,     setShowReqs]     = useState(false);
  const [requests,     setRequests]     = useState([]);
  const [reqsLoading,  setReqsLoading]  = useState(false);
  const [showEdit,     setShowEdit]     = useState(false);
  const [editForm,     setEditForm]     = useState({ location:"", date:"" });
  const [editLoading,  setEditLoading]  = useState(false);
  const [editError,    setEditError]    = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [ev, j, rs] = await Promise.all([
        db.getEvent(eventId),
        user ? db.isJoined(eventId, user.id) : Promise.resolve(false),
        user ? db.getRequestStatus(eventId, user.id) : Promise.resolve(null),
      ]);
      setEvent(ev); setJoined(j); setReqStatus(rs); setLoading(false);
    })();
  }, [eventId, user]);

  if (loading) return <div className="page"><Spinner /></div>;
  if (!event)  return <div className="page"><div className="container"><div className="empty"><div className="eico">❓</div><h3>Event not found</h3><button className="btn bg" style={{ marginTop:14 }} onClick={onBack}>← Go Back</button></div></div></div>;

  const full     = event.attendee_count >= event.max_participants;
  const pct      = capPct(event.attendee_count, event.max_participants);
  const isHost   = user && event.host_id === user.id;
  const isAdmin  = user && user.email === ADMIN_EMAIL;
  const canDelete           = isHost || isAdmin;
  const canViewParticipants = isHost || isAdmin;

  const loadRequests = async () => {
    if (showReqs) { setShowReqs(false); return; }
    setReqsLoading(true); setShowReqs(true);
    const data = await db.getJoinRequests(event.id);
    setRequests(data); setReqsLoading(false);
  };

  const handleApprove = async (userId) => {
    const r = await db.approveRequest(event.id, userId);
    if (r.error) { onRefresh("error", r.error); return; }
    // Remove from requests list
    setRequests(prev => prev.filter(u => u.id !== userId));
    // Refresh full event data to get correct count
    const updated = await db.getEvent(event.id);
    if (updated) setEvent(updated);
    // Refresh participants list if open
    await refreshParticipants();
    onRefresh("ok", "Request approved! ✅");
  };

  const handleReject = async (userId) => {
    const r = await db.rejectRequest(event.id, userId);
    if (r.error) { onRefresh("error", r.error); return; }
    setRequests(r => r.filter(u => u.id !== userId));
    onRefresh("ok", "Request rejected.");
  };

  const handleRequest = async () => {
    if (!user) { onShowAuth(); return; }
    setActing(true);
    if (reqStatus === "pending") {
      await db.cancelRequest(event.id, user.id);
      setReqStatus(null);
    } else {
      const r = await db.requestJoin(event.id, user.id);
      if (r.error === "already_requested") setReqStatus("pending");
      else if (!r.error) setReqStatus("pending");
    }
    setActing(false);
  };

  const loadParticipants = async () => {
    if (showParts) { setShowParts(false); return; }
    setPartsLoading(true); setShowParts(true);
    const data = await db.getParticipants(event.id);
    setParticipants(data); setPartsLoading(false);
  };

  const refreshParticipants = async () => {
    if (!showParts) return;
    const data = await db.getParticipants(event.id);
    setParticipants(data);
  };

  const openEdit = () => {
    const d = new Date(event.date);
    const pad = n => String(n).padStart(2,"0");
    const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setEditForm({ location: event.location, date: local });
    setEditError("");
    setShowEdit(e => !e);
  };

  const handleEdit = async () => {
    setEditLoading(true); setEditError("");
    const r = await db.updateEvent(event.id, editForm);
    setEditLoading(false);
    if (r.error) { setEditError(r.error); return; }
    setEvent(ev => ({ ...ev, location: editForm.location, date: new Date(editForm.date).toISOString() }));
    setShowEdit(false);
    onRefresh("ok", "Event updated! ✅");
  };

  const toggle = async () => {
    if (!user) { onShowAuth(); return; }
    setActing(true);
    const r = joined ? await db.leaveEvent(event.id, user.id) : await db.joinEvent(event.id, user.id);
    setActing(false);
    if (r.error) { onRefresh("error", r.error); return; }
    const nj = !joined; setJoined(nj);
    setEvent(ev => ({ ...ev, attendee_count: ev.attendee_count + (nj ? 1 : -1) }));
    onRefresh("ok", nj ? "Joined! 🎉" : "Left event.");
  };

  const handleDelete = async () => {
    if (!window.confirm("Are you sure you want to delete this event? This cannot be undone.")) return;
    setDeleting(true);
    const r = await db.deleteEvent(event.id);
    setDeleting(false);
    if (r.error) { onRefresh("error", r.error); return; }
    onRefresh("ok", "Event deleted.");
    onBack();
  };

  return (
    <div className="page"><div className="container" style={{ maxWidth:700 }}>
      <button className="back" onClick={onBack}>← Back to Events</button>
      <div className="dcard">
        <div className={`dcard-banner dcard-banner-${event.category}`}>
          <div className="dcard-banner-inner">
            <CTag cat={event.category} />
            {canDelete && (
              <button className="btn bsm" onClick={handleDelete} disabled={deleting}
                style={{ background:"rgba(0,0,0,0.4)", color:"#fff", border:"1px solid rgba(255,255,255,0.2)", backdropFilter:"blur(8px)" }}>
                {deleting ? "…" : "🗑 Delete"}
              </button>
            )}
          </div>
        </div>
        <div className="dcard-body">
          <div className="dtitle">{event.title}</div>
          <div className="dgrid">
            <div className="di"><div className="di-l">Date</div><div className="di-v">📅 {fmtDate(event.date)}</div></div>
            <div className="di"><div className="di-l">Time</div><div className="di-v">🕐 {fmtTime(event.date)}</div></div>
            <div className="di"><div className="di-l">Location</div><div className="di-v">📍 {event.location}</div></div>
            <div className="di"><div className="di-l">Host</div><div className="di-v">👤 {event.host_name}</div></div>
          </div>
          <div className="ddesc">{event.description}</div>
          <div className="hr" />
          <div className="stitle">Attendance</div>
          <div style={{ marginBottom:10 }}>
            <span style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:800, fontSize:24 }}>{event.attendee_count}</span>
            <span style={{ color:"var(--muted2)", fontSize:13, marginLeft:6 }}>/ {event.max_participants} joined · {pct}% full</span>
          </div>
          <CBar count={event.attendee_count} max={event.max_participants} />
          <div style={{ marginTop:22, display:"flex", gap:10, flexWrap:"wrap" }}>
            {event.is_private && !joined ? (
              reqStatus === "approved"
                ? <button className={`btn blg bd`} onClick={toggle} disabled={acting}>{acting ? "…" : "Leave Event"}</button>
                : reqStatus === "pending"
                ? <button className="btn blg" onClick={handleRequest} disabled={acting} style={{ background:"rgba(168,85,247,0.12)", color:"var(--purple)", border:"1px solid rgba(168,85,247,0.3)" }}>{acting ? "…" : "⏳ Pending · Cancel"}</button>
                : full
                ? <button className="btn bf blg" disabled>Event Full</button>
                : <button className="btn blg" onClick={handleRequest} disabled={acting} style={{ background:"rgba(168,85,247,0.12)", color:"var(--purple)", border:"1px solid rgba(168,85,247,0.3)" }}>{acting ? "…" : "🔒 Request to Join"}</button>
            ) : (
              full && !joined
                ? <button className="btn bf blg" disabled>Event Full</button>
                : <button className={`btn blg ${joined?"bd":"bp"}`} onClick={toggle} disabled={acting}>{acting ? "…" : joined ? "Leave Event" : "✦ Join Event"}</button>
            )}
            <button className="btn bg blg" onClick={() => { shareEvent(event.id, event.title); onRefresh("ok", "Link copied! 🔗"); }}>🔗 Share</button>
            {isHost && <button className="btn blg" onClick={openEdit} style={{ background:"rgba(163,230,53,0.1)", color:"var(--lime)", border:"1px solid rgba(163,230,53,0.25)" }}>✏️ Edit</button>}
            <button className="btn bg blg" onClick={onBack}>← Back</button>
          </div>

          {isHost && showEdit && (
            <div className="edit-panel">
              <div className="edit-header" onClick={openEdit}>
                <div className="edit-title">✏️ Edit Event Details</div>
                <span style={{ color:"var(--muted)", fontSize:13 }}>▲ Close</span>
              </div>
              <div className="edit-body">
                <div className="fg">
                  <label className="fl">📍 Location</label>
                  <input className="fi" placeholder="e.g. Main Hall, Room 101" value={editForm.location}
                    onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))} maxLength={300} />
                </div>
                <div className="fg">
                  <label className="fl">📅 Date & Time</label>
                  <input className="fi" type="datetime-local" min={todayMin()} max={DATE_MAX} value={editForm.date}
                    onChange={e => setEditForm(f => ({ ...f, date: e.target.value }))} />
                </div>
                {editError && <div className="ferr">{editError}</div>}
                <button className="btn bp" style={{ borderRadius:12, padding:"11px 0", justifyContent:"center" }}
                  onClick={handleEdit} disabled={editLoading}>
                  {editLoading ? "Saving…" : "✓ Save Changes"}
                </button>
              </div>
            </div>
          )}

          {canViewParticipants && event.is_private && (
            <div className="req-panel">
              <div className="req-header" onClick={loadRequests}>
                <div className="req-title">
                  📬 Join Requests
                  <span className="req-num">{showReqs ? requests.length : "📬"}</span>
                </div>
                <span style={{ color:"var(--muted)", fontSize:13 }}>{showReqs ? "▲ Hide" : "▼ Show"}</span>
              </div>
              {showReqs && (
                <div className="req-list">
                  {reqsLoading ? (
                    <div style={{ textAlign:"center", padding:"16px 0", color:"var(--muted)", fontSize:13 }}>Loading…</div>
                  ) : requests.length === 0 ? (
                    <div style={{ textAlign:"center", padding:"16px 0", color:"var(--muted)", fontSize:13 }}>No pending requests.</div>
                  ) : (
                    requests.map(p => (
                      <div key={p.id} className="req-item">
                        <div className="part-avatar">{p.name?.[0]?.toUpperCase() || "?"}</div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div className="part-name">{p.name}</div>
                          <div className="part-email">{p.email}</div>
                        </div>
                        <div className="req-actions">
                          <button className="req-approve" onClick={() => handleApprove(p.id)}>✓ Approve</button>
                          <button className="req-reject" onClick={() => handleReject(p.id)}>✗ Reject</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {canViewParticipants && (
            <div className="part-panel">
              <div className="part-header" onClick={loadParticipants}>
                <div className="part-title">
                  👥 Participants
                  <span className="part-num">{showParts ? participants.length : event.attendee_count}</span>
                </div>
                <span style={{ color:"var(--muted)", fontSize:13 }}>{showParts ? "▲ Hide" : "▼ Show"}</span>
              </div>
              {showParts && (
                <div className="part-list">
                  {partsLoading ? (
                    <div style={{ textAlign:"center", padding:"16px 0", color:"var(--muted)", fontSize:13 }}>Loading…</div>
                  ) : participants.length === 0 ? (
                    <div style={{ textAlign:"center", padding:"16px 0", color:"var(--muted)", fontSize:13 }}>No participants yet.</div>
                  ) : (
                    participants.map((p, i) => (
                      <div key={p.id} className="part-item">
                        <div className="part-avatar">{p.name?.[0]?.toUpperCase() || "?"}</div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div className="part-name">{p.name}</div>
                          <div className="part-email">{p.email}</div>
                        </div>
                        <span style={{ fontSize:11, color:"var(--muted)", fontWeight:600 }}>#{i+1}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div></div>
  );
}

// ─── Create Page ──────────────────────────────────────────────────────────────
function CreatePage({ user, onBack, onShowAuth, onCreated }) {
  const [form, setForm]       = useState({ title:"", description:"", category:"Social", date:"", location:"", max_participants:50, is_private:false });
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);

  if (!user) return <div className="page"><div className="container"><div className="empty"><div className="eico">🔐</div><h3>Sign in to create events</h3><button className="btn bp" style={{ marginTop:14 }} onClick={onShowAuth}>Sign In</button></div></div></div>;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const go  = async () => {
    setError("");
    if (!form.title.trim())       { setError("Title is required."); return; }
    if (!form.description.trim()) { setError("Description is required."); return; }
    if (!form.location.trim())    { setError("Location is required."); return; }
    if (!form.date)               { setError("Date & time are required."); return; }
    const maxP = parseInt(form.max_participants);
    if (isNaN(maxP) || maxP < 1) { setError("Max participants must be at least 1."); return; }
    setLoading(true);
    const r = await db.createEvent({ ...form, max_participants: maxP }, user.id);
    setLoading(false);
    if (r.error) setError(r.error); else onCreated();
  };

  return (
    <div className="page"><div className="container">
      <button className="back" onClick={onBack}>← Back</button>
      <div style={{ marginBottom:20 }}>
        <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:26, fontWeight:800, letterSpacing:"-0.5px" }}>✦ Host an Event</div>
        <p style={{ color:"var(--muted)", fontSize:12, marginTop:3 }}>Fill in the details to publish your campus event.</p>
      </div>
      <div className="ccard">
        <div className="f2">
          <div className="s2 fg"><label className="fl">Event Title *</label><input className="fi" placeholder="Give your event a catchy title" value={form.title} onChange={e => set("title", e.target.value)} maxLength={200} /></div>
          <div className="fg"><label className="fl">Category *</label><select className="fi" value={form.category} onChange={e => set("category", e.target.value)}>{VALID_CATS.map(c => <option key={c}>{c}</option>)}</select></div>
          <div className="fg"><label className="fl">Max Participants *</label><input className="fi" type="number" min={1} max={10000} value={form.max_participants} onChange={e => set("max_participants", e.target.value)} /></div>
          <div className="fg"><label className="fl">Date & Time * <span style={{ color:"var(--muted)", fontWeight:400, fontSize:10 }}>(today → Dec 2030)</span></label><input className="fi" type="datetime-local" min={todayMin()} max={DATE_MAX} value={form.date} onChange={e => set("date", e.target.value)} /></div>
          <div className="fg"><label className="fl">Location *</label><input className="fi" placeholder="e.g. Main Hall, Room 101" value={form.location} onChange={e => set("location", e.target.value)} maxLength={300} /></div>
          <div className="s2 fg"><label className="fl">Description *</label><textarea className="fi" rows={5} placeholder="Describe what attendees can expect…" value={form.description} onChange={e => set("description", e.target.value)} maxLength={2000} style={{ resize:"vertical" }} /></div>
          <div className="s2 fg">
            <label className="fl">Event Visibility</label>
            <div className={`private-toggle ${form.is_private?"on":""}`} onClick={() => set("is_private", !form.is_private)}>
              <div className="toggle-left">
                <span className="toggle-label">🔒 Private Event — Require Approval</span>
                <span className="toggle-desc">{form.is_private ? "Students must request to join. You approve or reject." : "Anyone can join instantly. Toggle to require approval."}</span>
              </div>
              <div className={`toggle-switch ${form.is_private?"on":""}`} />
            </div>
          </div>
        </div>
        {error && <div className="ferr">{error}</div>}
        <div style={{ display:"flex", gap:9, marginTop:20 }}>
          <button className="btn bp blg" onClick={go} disabled={loading}>{loading ? "Publishing…" : "✦ Publish Event"}</button>
          <button className="btn bg blg" onClick={onBack}>Cancel</button>
        </div>
      </div>
    </div></div>
  );
}

// ─── My Events Page ───────────────────────────────────────────────────────────
function MyPage({ user, onSelect, onRefresh, onShowAuth }) {
  const [tab,     setTab]     = useState("joined");
  const [data,    setData]    = useState({ joined:[], created:[] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    db.getMyEvents(user.id).then(d => { setData(d); setLoading(false); });
  }, [user]);

  if (!user) return <div className="page"><div className="container"><div className="empty"><div className="eico">🎟️</div><h3>Sign in to see your events</h3><button className="btn bp" style={{ marginTop:14 }} onClick={onShowAuth}>Sign In</button></div></div></div>;

  const list    = tab === "joined" ? data.joined : data.created;
  const isAdmin = user.email === ADMIN_EMAIL;
  const memberSince = new Date(user.created_at || Date.now()).getFullYear();
  const act  = async a => {
    if (a === "auth")           { onShowAuth(); return; }
    if (a === "share")          { onRefresh("ok", "Link copied! 🔗"); return; }
    if (a === "deleted")        { const d = await db.getMyEvents(user.id); setData(d); onRefresh("ok", "Event deleted."); return; }
    if (a.startsWith("error:")) { onRefresh("error", a.slice(6)); return; }
    const d = await db.getMyEvents(user.id); setData(d);
    onRefresh("ok", a === "joined" ? "Joined! 🎉" : "Left event.");
  };

  return (
    <div className="page"><div className="container">

      {/* Profile Header */}
      <div className="profile-header">
        <div className="profile-avatar">{user.name?.[0]?.toUpperCase() || "?"}</div>
        <div className="profile-info">
          <div className="profile-name">{user.name}</div>
          <div className="profile-email">{user.email}</div>
          <div className="profile-stats">
            <div className="profile-stat">
              <span className="profile-stat-num">{data.joined.length}</span>
              <span className="profile-stat-lbl">Joined</span>
            </div>
            <div className="profile-stat">
              <span className="profile-stat-num">{data.created.length}</span>
              <span className="profile-stat-lbl">Hosted</span>
            </div>
            <div className="profile-stat">
              <span className="profile-stat-num">{data.joined.length + data.created.length}</span>
              <span className="profile-stat-lbl">Total</span>
            </div>
          </div>
          {isAdmin && <div className="profile-badge">⚡ Platform Admin</div>}
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab==="joined"?"on":""}`} onClick={() => setTab("joined")}>🎟️ Joined ({data.joined.length})</button>
        <button className={`tab ${tab==="created"?"on":""}`} onClick={() => setTab("created")}>✦ Created ({data.created.length})</button>
      </div>
      {loading ? <Spinner />
        : list.length === 0
        ? <div className="empty"><div className="eico">{tab==="joined"?"🔍":"✨"}</div><h3>{tab==="joined"?"No events joined yet":"No events created yet"}</h3><p>{tab==="joined"?"Browse events and join something!":"Host your first campus event!"}</p></div>
        : <div className="grid">{list.map(e => <ECard key={e.id} event={e} user={user} onSelect={onSelect} onAction={act} />)}</div>
      }
    </div></div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage]             = useState("home");
  const [selId, setSelId]           = useState(null);
  const [user, setUser]             = useState(null);
  const [showAuth, setShowAuth]     = useState(false);
  const [toast, setToast]           = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [tick, setTick]             = useState(0);
  const [booting, setBooting]       = useState(true);

  // On first load: restore session + handle shared event links
  useEffect(() => {
    (async () => {
      const restored = await db.refreshSession();
      if (restored) setUser(restored);
      // Deep link: ?event=ID opens that event directly
      const params = new URLSearchParams(window.location.search);
      const eventId = params.get("event");
      if (eventId) {
        setSelId(eventId);
        setPage("detail");
        // Clean URL without reload
        window.history.replaceState({}, "", window.location.pathname);
      }
      setBooting(false);
    })();
  }, []);

  const showToast = useCallback((type, msg) => setToast({ type, msg, k: Date.now() }), []);
  const nav       = p => { setPage(p); setSelId(null); setMobileOpen(false); };
  const sel       = ev => { if (typeof ev === "string") { nav(ev); return; } setSelId(ev.id); setPage("detail"); };
  const refresh   = useCallback((type, msg) => { showToast(type, msg); setTick(t => t+1); }, [showToast]);

  if (booting) return (
    <div style={{ minHeight:"100vh", background:"#0E0E12", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <style>{css}</style>
      <div style={{ textAlign:"center" }}>
        <img src="https://pub-d2b9c326a58845019dfb974ae3ee9e9a.r2.dev/univibelogo.png" alt="UniVibe" style={{ height:120, width:"auto", margin:"0 auto 16px", display:"block" }} />
        <div className="spinner" style={{ margin:"0 auto" }} />
      </div>
    </div>
  );

  return (
    <ErrorBoundary>
      <div className="app">
        <style>{css}</style>
        <nav className="nav">
          <div className="nav-inner">
            <div className="nav-links">
              <button className={`nb ${page==="home"?"on":""}`} onClick={() => nav("home")}>Events</button>
              <button className={`nb ${page==="my"?"on":""}`} onClick={() => nav("my")}>My Events</button>
              <button className={`nb ${page==="create"?"on":""}`} onClick={() => nav("create")}>Host Event</button>
              {user ? (
                <><div className="avatar" title={user.name} onClick={() => nav("my")}>{user.name[0].toUpperCase()}</div>
                  <button className="nb out" onClick={() => { db.signOut(); setUser(null); nav("home"); showToast("ok","Signed out."); }}>Sign Out</button></>
              ) : (
                <button className="nb cta" onClick={() => setShowAuth(true)}>Sign In</button>
              )}
            </div>
          </div>
        </nav>
        <ErrorBoundary>
          {page==="home"   && <HomePage  key={tick} user={user} onSelect={sel} onRefresh={refresh} onShowAuth={() => setShowAuth(true)} />}
          {page==="detail" && selId && <DetailPage eventId={selId} user={user} onBack={() => nav("home")} onShowAuth={() => setShowAuth(true)} onRefresh={refresh} />}
          {page==="create" && <CreatePage user={user} onBack={() => nav("home")} onShowAuth={() => setShowAuth(true)} onCreated={() => { showToast("ok","Event published! 🎉"); nav("home"); setTick(t => t+1); }} />}
          {page==="my"     && <MyPage key={tick} user={user} onSelect={sel} onRefresh={refresh} onShowAuth={() => setShowAuth(true)} />}
        </ErrorBoundary>
        {showAuth && <AuthModal onClose={() => setShowAuth(false)} onAuth={u => { setUser(u); showToast("ok", `Welcome, ${u.name}! 🎓`); }} />}
        {toast && <Toast key={toast.k} msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}
      </div>
    </ErrorBoundary>
  );
}