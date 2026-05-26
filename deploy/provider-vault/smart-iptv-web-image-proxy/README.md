# Smart IPTV Web Provider-Vault Image Proxy

This folder records the live DaveTV provider-vault patch deployed to:

```text
/opt/davetv/services/Smart-IPTV-Web
```

Purpose:

- sanitize provider logo/poster URLs before they leave the server;
- reject credential-shaped image URLs;
- proxy safe HTTP/HTTPS logos through same-origin
  `/api/provider-vault/image?src=...`;
- remove mixed-content browser warnings in hosted apps such as Open TV and
  IPTV Restream while keeping raw provider credentials server-side.

Live source paths:

```text
/opt/davetv/services/Smart-IPTV-Web/lib/server/providerVault.ts
/opt/davetv/services/Smart-IPTV-Web/app/api/provider-vault/image/route.ts
```

Verification:

```text
C:\Users\Admin\Downloads\VPS\_visual_artifacts\apps-provider-ready-sweep-20260526\summary.json
```

Latest accepted sweep: `12/12 passed`, `2026-05-26T19:51:01.490Z`, with zero
captured console errors across the provider-ready app collection.
