# Moonshot Arena

An original browser-first, first-person team arena shooter. It runs on desktop and mobile browsers and can be packaged as an Android app with Capacitor.

## Run the game and private server

1. Install Node.js 20 or newer.
2. In this folder, run `npm install`, then `npm start`.
3. Open `http://localhost:3000`.

For a private server on your Wi-Fi, allow TCP port 3000 through the host computer's firewall and share `http://<computer-LAN-IP>:3000` with players on that network. Public hosting requires deploying this Node.js application to an internet-accessible host with WebSocket support and HTTPS/WSS.

Players can join the public room browser, create a public room, or host a private room and share its six-character code. The server uses separate, short-lived rooms rather than a single global match.

The included `Dockerfile` can be deployed to a container host. Set `PORT` if your host supplies a port. Configure TLS/HTTPS at the host or reverse proxy so browsers can establish a secure WebSocket connection.

## Android

Install Android Studio with Android SDK/API 35 and a compatible Java JDK, install Node.js, and run `npm install`. Set `MOONSHOT_SERVER_URL` to the public HTTPS URL of your deployed server before building the APK:

```powershell
$env:MOONSHOT_SERVER_URL = "https://your-game-server.example"
npm run android:init
npm run android:apk
```

The debug APK is copied to `downloads/moonshot-arena.apk`. The `/download` page provides it after it has been built. For a hosted download page, include that APK in `downloads/` before building and deploying the server container.

`npm run build:web` copies Three.js into `public/vendor`, so the game renderer is bundled for Android and does not depend on a third-party script CDN. Public browser and mobile play needs internet access. A deployed public game server must use HTTPS/WSS. The app is cross-platform, but this source project does not upload itself to a public host; a hosting provider is needed for an internet-accessible server.
