# LiveKit Cloud setup (free tier) — step-by-step

This guide gets you from zero to a working LiveKit integration in your Escorta app so you can develop live video and 1-1 video chat.

---

## 1. Create a LiveKit Cloud account and project

1. Go to **[https://cloud.livekit.io](https://cloud.livekit.io)**.
2. Sign up (email or GitHub). No credit card required for the free tier.
3. Create a **new project** (e.g. "Escorta Dev").
4. Open the project and go to **Settings** (or **Project settings**).
5. Copy:
   - **LiveKit URL** (e.g. `wss://your-project.livekit.cloud`)
   - **API Key**
   - **API Secret**

Keep the secret safe; it’s only for your backend.

---

## 2. Add environment variables

Add these to your `.env` (and `.env.example` without real values):

```env
# LiveKit Cloud (free tier)
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
```

For the frontend you only need the **URL** (it’s public). So you can also set:

```env
NEXT_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud
```

and use `NEXT_PUBLIC_LIVEKIT_URL` in client components so you don’t have to pass it from an API.

---

## 3. Install packages

From the project root:

```bash
# Backend: generate access tokens
npm install livekit-server-sdk

# Frontend: connect to rooms and render video
npm install livekit-client @livekit/components-react
```

Optional: if you use LiveKit’s prebuilt UI styles:

```bash
npm install @livekit/components-styles
```

---

## 4. Token API in your Next.js app

Your backend must issue a **short-lived token** for each participant. Create this API route:

**File:** `src/app/api/livekit/token/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

export async function POST(req: NextRequest) {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json(
      { error: "LiveKit not configured" },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const { roomName, participantName } = body;

  if (!roomName || !participantName) {
    return NextResponse.json(
      { error: "roomName and participantName required" },
      { status: 400 }
    );
  }

  // TODO: validate your app user (e.g. JWT) and set identity/metadata
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: participantName,
    name: participantName,
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  const token = await at.toJwt();
  return NextResponse.json({ token, url: LIVEKIT_URL });
}
```

For production you will:

- Authenticate the request (e.g. your JWT).
- Derive `participantName` / `identity` from the logged-in user.
- Optionally restrict `canPublish` / `canSubscribe` by role (e.g. viewers can only subscribe).

---

## 5. Minimal test page (optional)

Create a simple page that fetches a token and joins a room to verify the setup.

**File:** `src/app/livekit-test/page.tsx`

```tsx
"use client";

import { useEffect, useState } from "react";
import { Room } from "livekit-client";

const ROOM_NAME = "escorta-test-room";

export default function LiveKitTestPage() {
  const [status, setStatus] = useState<string>("Click Connect");
  const [room, setRoom] = useState<Room | null>(null);

  const connect = async () => {
    setStatus("Getting token…");
    const res = await fetch("/api/livekit/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomName: ROOM_NAME,
        participantName: `user-${Date.now()}`,
      }),
    });
    if (!res.ok) {
      setStatus(`Error: ${res.status}`);
      return;
    }
    const { token, url } = await res.json();
    setStatus("Connecting…");
    const r = new Room();
    await r.connect(url, token);
    setRoom(r);
    setStatus(`Connected to ${ROOM_NAME}`);
  };

  const disconnect = () => {
    room?.disconnect();
    setRoom(null);
    setStatus("Disconnected");
  };

  useEffect(() => {
    return () => {
      room?.disconnect();
    };
  }, [room]);

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold mb-4">LiveKit test</h1>
      <p className="text-sm text-gray-500 mb-4">{status}</p>
      {!room ? (
        <button
          type="button"
          onClick={connect}
          className="px-4 py-2 bg-[var(--color-champagne)] text-[var(--color-obsidian)] rounded"
        >
          Connect
        </button>
      ) : (
        <button
          type="button"
          onClick={disconnect}
          className="px-4 py-2 border border-red-400 text-red-300 rounded"
        >
          Disconnect
        </button>
      )}
    </div>
  );
}
```

1. Run `npm run dev`.
2. Open `http://localhost:3000/livekit-test`.
3. Click **Connect**. You should see “Connected to escorta-test-room”.
4. Open the same URL in another tab and connect again: both participants are in the same room (you can later add a simple video grid with `@livekit/components-react` to see each other).

If this works, LiveKit Cloud and your token API are correctly set up.

---

## 6. Using the app over LAN (HTTP) — camera/mic

Browsers only allow camera and microphone on **secure contexts** (HTTPS or `localhost`). If you open the app from another device using your machine’s IP (e.g. `http://192.168.29.222:3000/live/go`), the browser will **not** show the permission prompt and media will fail.

**If you can’t use HTTPS**, use Chrome’s dev flag so it treats your HTTP origin as secure (development only):

### Option A — Chrome flag (one-time)

1. **Close Chrome completely** (all windows).
2. Start Chrome with the flag (replace the URL/port if yours is different):

   **Windows (Command Prompt or PowerShell):**
   ```text
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --unsafely-treat-insecure-origin-as-secure="http://192.168.29.222:3000"
   ```

   **macOS:**
   ```text
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --unsafely-treat-insecure-origin-as-secure="http://192.168.29.222:3000"
   ```

   **Linux:**
   ```text
   google-chrome --unsafely-treat-insecure-origin-as-secure="http://192.168.29.222:3000"
   ```

3. In that Chrome window, open `http://192.168.29.222:3000/live/go`. You should now get the camera/mic prompt.

### Option B — chrome://flags (persists until you change it)

1. In Chrome, go to: `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. In the text box, enter: `http://192.168.29.222:3000` (use your real IP and port).
3. Set the dropdown to **Enabled**.
4. Click **Relaunch**.

Use this only for local/LAN development. For production, use HTTPS.

---

## 7. Next steps for your features

- **1-1 video:** Use the same token API; pass `roomName` (e.g. `video-call-${sessionId}`) and participant identity. In the call page, use `Room.connect(url, token)` and render local/remote tracks with `@livekit/components-react` (e.g. `VideoTrack`, `useTracks`).
- **Live (one-to-many):** Companion gets a token with `canPublish: true`; clients get a token with `canPublish: false`, `canSubscribe: true` for the same room. Companion publishes one video track; clients subscribe.
- **Auth:** In `POST /api/livekit/token`, read your JWT cookie/header, verify the user, and set `identity` and optional `metadata` from your user id/role. Reject unauthenticated requests.

---

## 8. Free tier limits (reminder)

- **5,000 WebRTC minutes/month**
- **100 concurrent connections**

Enough for development and demos. When you go to production and need more, upgrade to a paid plan or self-host LiveKit.
