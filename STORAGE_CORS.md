# Storage CORS and Download Proxy

## What was the error?

- **Error:** `Cross-Origin Request Blocked … (Reason: CORS header 'Access-Control-Allow-Origin' missing). Status code: 400.`
- **URL:** `https://bdmgrmzsaacjguatnogm.supabase.co/storage/v1/object/uic-documents/.../Comissions_ANAM_BEN.csv`

Your app (e.g. `http://localhost:3000`) and Supabase Storage are different origins. When the **browser** requests that CSV directly from Supabase, the response either returns 400 (e.g. private bucket or bad path) or doesn’t send CORS headers that allow your origin, so the browser blocks the response and reports “CORS header missing”.

## Fix: use the download proxy (recommended)

The app has an API route that downloads the file **on the server** and streams it to the browser. The browser only talks to your app, so there is no cross-origin request to Storage.

- **By path:**  
  `GET /api/storage/download?path=Unlimited%20Insurance%2FAMAM%20(American%20Amicable)%2FCommission%2FComissions_ANAM_BEN.csv`  
  (Use URL-encoded path; no leading slash.)

- **By file id:**  
  `GET /api/storage/download?fileId=<files.id uuid>`

Use these URLs anywhere you would have used the direct Supabase Storage URL (e.g. “Open” / “Download” links, or `fetch()` for CSV).

## Optional: allow Storage CORS in Supabase

If you prefer the browser to hit Storage directly, configure CORS for the project that hosts the bucket (`bdmgrmzsaacjguatnogm`):

1. Supabase Dashboard → **Project** → **Storage** (or **Settings** if CORS is there).
2. Add allowed origins, e.g. `http://localhost:3000` and your production URL.

Note: Supabase may not expose per-bucket CORS in the UI; in that case the proxy is the reliable fix.
