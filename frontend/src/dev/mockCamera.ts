// Dev-only fake printer camera for `npm run dev:mock`: an animated SVG (16:9, like the K2 SE's 1280×720 camera)
// of a print in progress. Only referenced behind `import.meta.env.DEV && VITE_MOCK`, so builds drop it.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
<defs>
  <radialGradient id="glow" cx="50%" cy="30%" r="75%"><stop offset="0" stop-color="#3a3f47"/><stop offset="1" stop-color="#0d0f12"/></radialGradient>
  <linearGradient id="bed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2f36"/><stop offset="1" stop-color="#16181c"/></linearGradient>
  <linearGradient id="part" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#c2410c"/><stop offset=".45" stop-color="#fb923c"/><stop offset="1" stop-color="#9a3412"/></linearGradient>
  <pattern id="pei" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="7" cy="7" r="1.2" fill="#3b4048"/></pattern>
</defs>
<rect width="1280" height="720" fill="url(#glow)"/>
<path d="M150 560 L1130 560 L1010 330 L270 330 Z" fill="url(#bed)"/>
<path d="M150 560 L1130 560 L1010 330 L270 330 Z" fill="url(#pei)" opacity=".7"/>
<g>
  <rect x="520" y="300" width="240" height="250" rx="34" fill="url(#part)">
    <animate attributeName="y" values="520;300;300" keyTimes="0;.9;1" dur="24s" repeatCount="indefinite"/>
    <animate attributeName="height" values="30;250;250" keyTimes="0;.9;1" dur="24s" repeatCount="indefinite"/>
  </rect>
  <path d="M520 560h240" stroke="#14532d" stroke-width="5" opacity=".7"/>
</g>
<g>
  <animateTransform attributeName="transform" type="translate" values="-90 0;110 0;-90 0" dur="1.6s" repeatCount="indefinite"/>
  <g>
    <animateTransform attributeName="transform" type="translate" values="0 220;0 0;0 0" keyTimes="0;.9;1" dur="24s" repeatCount="indefinite" additive="sum"/>
    <rect x="560" y="120" width="160" height="150" rx="14" fill="#1f2329" stroke="#3b4048" stroke-width="3"/>
    <rect x="580" y="140" width="120" height="16" rx="4" fill="#0ea5e9" opacity=".8"/>
    <path d="M620 270h40l-12 26h-16z" fill="#a8a29e"/>
    <circle cx="640" cy="300" r="4" fill="#fdba74"><animate attributeName="opacity" values="1;.4;1" dur=".4s" repeatCount="indefinite"/></circle>
  </g>
</g>
<rect x="0" y="0" width="1280" height="720" fill="none" stroke="#000" stroke-width="80" opacity=".35"/>
<text x="40" y="684" font-family="monospace" font-size="22" fill="#e5e7eb" opacity=".75">K2 SE · CAM</text>
</svg>`

export const MOCK_CAMERA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
